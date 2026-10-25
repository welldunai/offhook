// Microphone capture for the live demo: downsamples the browser's audio (usually
// 48 kHz) to 16 kHz mono and posts 20 ms chunks of 16-bit little-endian PCM.
// Each output sample averages the input samples it covers, a simple low-pass
// that keeps speech clear without aliasing hiss.

const TARGET_RATE = 16000;
const CHUNK = 320; // 20 ms at 16 kHz

class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / TARGET_RATE; // `sampleRate` is the context's rate
    this.acc = 0; // sum of input samples for the current output sample
    this.count = 0; // how many are in it
    this.pos = 0; // input position within the current output sample
    this.out = new Int16Array(CHUNK);
    this.n = 0;
  }

  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    if (!input) return true;
    for (let i = 0; i < input.length; i++) {
      this.acc += input[i];
      this.count++;
      this.pos++;
      if (this.pos >= this.ratio) {
        this.pos -= this.ratio;
        const s = Math.max(-1, Math.min(1, this.acc / this.count));
        this.out[this.n++] = s < 0 ? s * 0x8000 : s * 0x7fff;
        this.acc = 0;
        this.count = 0;
        if (this.n === CHUNK) {
          this.port.postMessage(this.out.buffer, [this.out.buffer]);
          this.out = new Int16Array(CHUNK);
          this.n = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor("pcm-capture", PcmCapture);
