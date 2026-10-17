import { MicVAD } from '@ricky0123/vad-web'
import { MIC_SAMPLE_RATE, type EngineError } from '../../../../shared/voice'
import { BargeInDetector, DEFAULT_BARGE_IN } from './bargeIn'
import workletUrl from './pcmWorklet?worker&url'

const asset = (name: string): string => new URL(`./vad-assets/${name}`, location.href).href

export class EngineFailure extends Error {
  constructor(readonly info: EngineError) {
    super(info.message)
  }
}

export function describeMicError(err: unknown): EngineError {
  const name = err instanceof DOMException ? err.name : ''
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return {
      code: 'permission-denied',
      message:
        'Microphone access was denied. Allow ECHO to use the microphone (Windows: Settings → Privacy & security → Microphone; macOS: System Settings → Privacy & Security → Microphone), then try again.'
    }
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return { code: 'no-microphone', message: 'No microphone was found. Plug one in or choose an input device, then try again.' }
  }
  if (name === 'NotReadableError' || name === 'AbortError') {
    return { code: 'mic-error', message: 'The microphone is busy or unavailable. Close other apps using it and try again.' }
  }
  return { code: 'mic-error', message: 'Could not start the microphone.' }
}

export interface CaptureOptions {
  muted: boolean
  /** Sustained speech (ms) while ECHO plays that counts as an interruption; 0 = off. */
  bargeInMs: number
  isPlaying(): boolean
  onBargeIn(): void
  /** 80 ms of 16 kHz mono PCM16. */
  onFrame(pcm: ArrayBuffer): void
  /** Local voice activity (already gated by mute). */
  onSpeech(speaking: boolean): void
  onFatal(err: EngineError): void
}

/**
 * One continuous microphone stream for the whole conversation: browser echo
 * cancellation / noise suppression / auto gain, an AudioWorklet that frames
 * the audio for Deepgram, and Silero VAD for instant barge-in detection.
 */
export class MicCapture {
  private stream: MediaStream | null = null
  private ctx: AudioContext | null = null
  private node: AudioWorkletNode | null = null
  private vad: MicVAD | null = null
  private muted: boolean
  private closed = false

  private constructor(private readonly opts: CaptureOptions) {
    this.muted = opts.muted
  }

  static async open(opts: CaptureOptions): Promise<MicCapture> {
    const cap = new MicCapture(opts)
    try {
      await cap.init()
    } catch (err) {
      cap.close()
      throw err instanceof EngineFailure ? err : new EngineFailure(describeMicError(err))
    }
    return cap
  }

  private async init(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new EngineFailure({ code: 'audio-error', message: 'Audio capture is not available in this window.' })
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true
      }
    })
    this.stream = stream
    const track = stream.getAudioTracks()[0]
    track.addEventListener('ended', () => {
      if (!this.closed) this.opts.onFatal({ code: 'mic-error', message: 'The microphone was disconnected.' })
    })

    // 16 kHz context: the stream is resampled once, here, instead of in our own code.
    const ctx = new AudioContext({ sampleRate: MIC_SAMPLE_RATE, latencyHint: 'interactive' })
    this.ctx = ctx
    if (ctx.sampleRate !== MIC_SAMPLE_RATE) {
      throw new EngineFailure({
        code: 'audio-error',
        message: `Audio device runs at ${ctx.sampleRate} Hz; 16 kHz capture is required.`
      })
    }
    await ctx.audioWorklet.addModule(workletUrl)

    const source = ctx.createMediaStreamSource(stream)
    const node = new AudioWorkletNode(ctx, 'pcm-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] })
    this.node = node
    node.port.onmessage = (e: MessageEvent<ArrayBuffer>): void => {
      if (!this.closed) this.opts.onFrame(e.data)
    }
    node.port.postMessage({ type: 'mute', muted: this.muted })

    // A worklet is only pulled when it is connected to the graph; a silent gain keeps it running without feedback.
    const silent = ctx.createGain()
    silent.gain.value = 0
    source.connect(node)
    node.connect(silent)
    silent.connect(ctx.destination)

    // Silero VAD shares this stream and context. If it can't load, the engine still works:
    // barge-in then relies on Flux's StartOfTurn alone.
    void this.startVad(ctx, stream)
  }

  private async startVad(ctx: AudioContext, stream: MediaStream): Promise<void> {
    let vadMax = 0
    let vadFrames = 0
    const barge = new BargeInDetector({ ...DEFAULT_BARGE_IN, needMs: this.opts.bargeInMs })
    try {
      const vad = await MicVAD.new({
        model: 'v5',
        audioContext: ctx,
        getStream: async () => stream,
        pauseStream: async () => {}, // never stop our shared stream
        resumeStream: async () => stream,
        baseAssetPath: asset(''),
        onnxWASMBasePath: asset(''),
        startOnLoad: true,
        onFrameProcessed: (p) => {
          vadMax = Math.max(vadMax, p.isSpeech)
          if (this.muted || this.closed || !this.opts.isPlaying()) barge.reset()
          else if (barge.feed(p.isSpeech, performance.now())) {
            console.info('[voice-engine] sustained speech while ECHO is playing: barge-in')
            this.opts.onBargeIn()
          }
          if (++vadFrames % 62 === 0) {
            console.debug('[voice-engine] VAD max speech probability (last ~2 s):', vadMax.toFixed(2))
            vadMax = 0
          }
        },
        positiveSpeechThreshold: 0.6,
        negativeSpeechThreshold: 0.4,
        redemptionMs: 300,
        minSpeechMs: 120,
        onSpeechRealStart: () => {
          console.info('[voice-engine] VAD speech start')
          if (!this.muted && !this.closed) this.opts.onSpeech(true)
        },
        onSpeechEnd: () => {
          console.info('[voice-engine] VAD speech end')
          if (!this.closed) this.opts.onSpeech(false)
        }
      })
      if (this.closed) {
        await vad.destroy()
        return
      }
      this.vad = vad
      console.info('[voice-engine] local VAD ready')
    } catch (err) {
      console.warn('[voice-engine] local VAD unavailable; using speech-recognition turn events only', err)
    }
  }

  setMuted(muted: boolean): void {
    this.muted = muted
    this.node?.port.postMessage({ type: 'mute', muted })
  }

  close(): void {
    this.closed = true
    const vad = this.vad
    this.vad = null
    void vad?.destroy().catch(() => {})
    if (this.node) {
      this.node.port.onmessage = null
      this.node.disconnect()
    }
    this.node = null
    this.stream?.getTracks().forEach((t) => t.stop())
    this.stream = null
    void this.ctx?.close().catch(() => {})
    this.ctx = null
  }
}
