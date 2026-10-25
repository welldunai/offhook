// One live demo call over the voice server's WebSocket (app/demo/server.py).
import { CallAudio } from "./audio";
import type { SessionStart } from "./client";

export interface CallHandlers {
  onLive(): void;
  onTranscript(who: "agent" | "person", text: string): void;
  onResult(key: string, value: unknown): void;
  onWrapUp(): void;
  /** The call is over. `message` is set when it ended because of a problem. */
  onEnded(reason: string | null, message?: string): void;
}

const MIC_ERRORS: Record<string, string> = {
  NotAllowedError: "The call needs your microphone. Allow it in your browser's address bar, then start the call again.",
  NotFoundError: "We couldn't find a microphone. Connect one and start the call again.",
};

/**
 * Gets the microphone ready before a session is created, so a refused prompt
 * doesn't use up one of the visitor's calls.
 * Returns: the audio, ready to stream. Throws an Error with a message for the visitor.
 */
export async function prepareAudio(): Promise<{ audio: CallAudio; flush: (send: (b: ArrayBuffer) => void) => void }> {
  const audio = new CallAudio();
  let sink: ((b: ArrayBuffer) => void) | null = null;
  try {
    // Until the socket is open, chunks are dropped; the agent speaks first anyway.
    await audio.start((pcm) => sink?.(pcm));
  } catch (e) {
    audio.stop();
    const name = (e as DOMException)?.name ?? "";
    throw new Error(MIC_ERRORS[name] ?? "We couldn't start your microphone. Check your browser's settings and try again.");
  }
  return { audio, flush: (send) => (sink = send) };
}

export class LiveCall {
  private ws: WebSocket | null = null;
  private endReason: string | null = null;
  private problem: string | undefined;
  private done = false;

  /**
   * Args: session — from POST /sessions; prepared — from prepareAudio(); on — UI callbacks.
   */
  constructor(
    private session: SessionStart,
    private prepared: Awaited<ReturnType<typeof prepareAudio>>,
    private on: CallHandlers,
  ) {}

  /** Connects and starts streaming. Events arrive through the handlers. */
  connect(): void {
    const url = `${this.session.voice_url}?ticket=${encodeURIComponent(this.session.ticket)}`;
    const ws = new WebSocket(url);
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
      else if (msg.type === "ended") this.endReason = String(msg.reason ?? "");
      else if (msg.type === "error") this.problem = String(msg.message ?? "The call ended because of a problem.");
    };
    ws.onclose = (e) => {
      // Let the goodbye finish playing before releasing the audio.
      const wait = Math.max(0, this.prepared.audio.agentSpeaking ? 1500 : 0);
      setTimeout(() => this.finish(e.wasClean || this.endReason ? null : "The connection dropped."), wait);
    };
  }

  /** Hangs up from the visitor's side. */
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
    this.on.onEnded(this.endReason, this.problem ?? (this.endReason ? undefined : dropped ?? undefined));
  }
}
