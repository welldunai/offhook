// Audio for test calls: the microphone in, the agent's voice out, both as
// 16 kHz mono 16-bit PCM (app/browser/serializer.py). Copied from site/src/demo/audio.ts.

const RATE = 16000;

export class CallAudio {
  private ctx: AudioContext;
  private stream: MediaStream | null = null;
  private capture: AudioWorkletNode | null = null;
  private nextTime = 0; // when the queued agent audio finishes, in ctx time
  private playing: AudioBufferSourceNode[] = [];

  /** Creates the audio context. Call from a click, so browsers allow sound. */
  constructor() {
    this.ctx = new AudioContext();
  }

  /**
   * Asks for the microphone and starts capturing.
   * Args: onChunk — receives each 20 ms chunk of PCM.
   * Throws: the browser's error if the microphone is refused or missing.
   */
  async start(onChunk: (pcm: ArrayBuffer) => void): Promise<void> {
    await this.ctx.resume();
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    await this.ctx.audioWorklet.addModule("/mic-worklet.js");
    const source = this.ctx.createMediaStreamSource(this.stream);
    this.capture = new AudioWorkletNode(this.ctx, "pcm-capture");
    this.capture.port.onmessage = (e) => onChunk(e.data as ArrayBuffer);
    // Worklets only run when connected to the graph; a muted gain keeps it silent.
    const mute = this.ctx.createGain();
    mute.gain.value = 0;
    source.connect(this.capture).connect(mute).connect(this.ctx.destination);
  }

  /**
   * Queues a chunk of the agent's voice right after what's already queued.
   * Args: pcm — 16 kHz mono 16-bit little-endian PCM.
   */
  play(pcm: ArrayBuffer): void {
    const samples = new Int16Array(pcm);
    if (!samples.length) return;
    const buffer = this.ctx.createBuffer(1, samples.length, RATE);
    const ch = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) ch[i] = samples[i] / 0x8000;
    const node = this.ctx.createBufferSource();
    node.buffer = buffer;
    node.connect(this.ctx.destination);
    const at = Math.max(this.ctx.currentTime + 0.03, this.nextTime);
    node.start(at);
    this.nextTime = at + buffer.duration;
    this.playing.push(node);
    node.onended = () => (this.playing = this.playing.filter((n) => n !== node));
  }

  /** Stops the agent mid-sentence: the person started talking over it. */
  interrupt(): void {
    for (const n of this.playing) n.stop();
    this.playing = [];
    this.nextTime = 0;
  }

  /** True while the agent's voice is playing. */
  get agentSpeaking(): boolean {
    return this.ctx.currentTime < this.nextTime;
  }

  /** Releases the microphone and the audio context. */
  stop(): void {
    this.interrupt();
    this.capture?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.ctx.close();
  }
}
