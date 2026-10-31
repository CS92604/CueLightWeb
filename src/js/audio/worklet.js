// Runs in the audio thread. Takes whatever the browser hands over, mixes it down to one channel, and posts it to the page
// in blocks of about 2,000 samples at the device's own sample rate (the page brings it down to 16 kHz).
class CueLightCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.block = new Float32Array(2048);
    this.filled = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const frames = input[0].length;
    for (let i = 0; i < frames; i++) {
      let sum = 0;
      for (let c = 0; c < input.length; c++) sum += input[c][i];
      this.block[this.filled++] = sum / input.length;
      if (this.filled === this.block.length) {
        this.port.postMessage(this.block, [this.block.buffer]);
        this.block = new Float32Array(2048);
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor('cuelight-capture', CueLightCapture);
