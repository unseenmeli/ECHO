// Runs on the audio rendering thread. Converts the microphone to 16 kHz mono
// PCM16 in 80 ms frames (the size Deepgram recommends for Flux) and hands them
// to the engine. While muted it emits silence instead of stopping, so the
// speech-recognition connection stays alive without sending the user's voice.

declare class AudioWorkletProcessor {
  readonly port: MessagePort
  constructor()
}
declare function registerProcessor(name: string, processor: unknown): void

const FRAME_SAMPLES = 1280 // 80 ms at 16 kHz

class PcmCapture extends AudioWorkletProcessor {
  private frame = new Int16Array(FRAME_SAMPLES)
  private filled = 0
  private muted = false

  constructor() {
    super()
    this.port.onmessage = (e: MessageEvent): void => {
      if (e.data && e.data.type === 'mute') this.muted = !!e.data.muted
    }
  }

  process(inputs: Float32Array[][]): boolean {
    const channel = inputs[0]?.[0]
    if (!channel) return true
    for (let i = 0; i < channel.length; i++) {
      const s = this.muted ? 0 : Math.max(-1, Math.min(1, channel[i]))
      this.frame[this.filled++] = s < 0 ? s * 0x8000 : s * 0x7fff
      if (this.filled === FRAME_SAMPLES) {
        const buffer = this.frame.buffer
        this.port.postMessage(buffer, [buffer])
        this.frame = new Int16Array(FRAME_SAMPLES)
        this.filled = 0
      }
    }
    return true
  }
}

registerProcessor('pcm-capture', PcmCapture)
export {}
