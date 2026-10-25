// One test call over the API's WebSocket (app/api/test_calls.py), using the same
// wire format as the website's demo (site/src/demo/call.ts).
import { CallAudio } from "./audio";

export interface CallHandlers {
  onLive(): void;
  onTranscript(who: "agent" | "person", text: string): void;
  onResult(key: string, value: unknown): void;
  onWrapUp(): void;
  /** The call is over. `message` is set when it ended because of a problem. */
  onEnded(reason: string | null, summary: string | null, message?: string): void;
}

const MIC_ERRORS: Record<string, string> = {
  NotAllowedError: "The test call needs your microphone. Allow it in your browser's address bar, then start again.",
  NotFoundError: "We couldn't find a microphone. Connect one and start again.",
};

/**
 * Turns the microphone on before asking the API for a ticket, so a refused
 * prompt doesn't waste one.
 * Returns: the audio, ready to stream. Throws an Error with a message to show.
 */
export async function prepareAudio(): Promise<{ audio: CallAudio; flush: (send: (b: ArrayBuffer) => void) => void }> {
  const audio = new CallAudio();
  let sink: ((b: ArrayBuffer) => void) | null = null;
  try {
    await audio.start((pcm) => sink?.(pcm));
  } catch (e) {
    audio.stop();
    const name = (e as DOMException)?.name ?? "";
    throw new Error(MIC_ERRORS[name] ?? "We couldn't start your microphone. Check your browser's settings and try again.", { cause: e });
  }
  return { audio, flush: (send) => (sink = send) };
}

export class LiveCall {
  private ws: WebSocket | null = null;
  private endReason: string | null = null;
  private summary: string | null = null;
  private problem: string | undefined;
  private done = false;

  /**
   * Args: wsUrl and ticket — from POST /v1/agents/{id}/test-call; prepared — from
   *   prepareAudio(); on — UI callbacks.
   */
  private wsUrl: string;
  private ticket: string;
  private prepared: Awaited<ReturnType<typeof prepareAudio>>;
  private on: CallHandlers;

  constructor(wsUrl: string, ticket: string, prepared: Awaited<ReturnType<typeof prepareAudio>>, on: CallHandlers) {
    this.wsUrl = wsUrl;
    this.ticket = ticket;
    this.prepared = prepared;
    this.on = on;
  }

  /** Connects and starts streaming. */
  connect(): void {
    const ws = new WebSocket(`${this.wsUrl}?ticket=${encodeURIComponent(this.ticket)}`);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onopen = () => {
      this.prepared.flush((pcm) => ws.readyState === WebSocket.OPEN && ws.send(pcm));
      this.on.onLive();
    };
    ws.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) return this.prepared.audio.play(e.data);
      let msg: { type?: string; [k: string]: unknown };
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (msg.type === "transcript") this.on.onTranscript(msg.who === "agent" ? "agent" : "person", String(msg.text ?? ""));
      else if (msg.type === "result") this.on.onResult(String(msg.key ?? ""), msg.value);
      else if (msg.type === "interrupt") this.prepared.audio.interrupt();
      else if (msg.type === "wrap_up") this.on.onWrapUp();
      else if (msg.type === "ended") {
        this.endReason = String(msg.reason ?? "");
        if (typeof msg.summary === "string") this.summary = msg.summary;
      } else if (msg.type === "error") this.problem = String(msg.message ?? "The call ended because of a problem.");
    };
    ws.onclose = (e) => {
      const wait = this.prepared.audio.agentSpeaking ? 1500 : 0; // let the goodbye finish
      setTimeout(() => this.finish(e.wasClean || this.endReason ? null : "The connection dropped."), wait);
    };
  }

  /** Hangs up from the dashboard. */
  hangUp(): void {
    this.endReason ??= "hung_up";
    this.ws?.close(1000);
    this.finish(null);
  }

  /** True while the agent's voice is playing (for the waveform). */
  get agentSpeaking(): boolean {
    return this.prepared.audio.agentSpeaking;
  }

  /** Stops audio and reports the end, once. */
  private finish(dropped: string | null): void {
    if (this.done) return;
    this.done = true;
    this.prepared.audio.stop();
    this.on.onEnded(this.endReason, this.summary, this.problem ?? (this.endReason ? undefined : dropped ?? undefined));
  }
}
