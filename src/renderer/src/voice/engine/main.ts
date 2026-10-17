import { EngineFailure, MicCapture, describeMicError } from './capture'
import { Playback } from './playback'

// Hidden audio-engine window: owns the microphone and speakers. Nothing here
// talks to the network; all audio goes through the preload bridge to the main
// process, which holds the Deepgram and Anthropic credentials.

const engine = window.voiceEngine
let capture: MicCapture | null = null
let playback: Playback | null = null
let starting = false
const unsubscribe: Array<() => void> = []

async function start(muted: boolean, bargeInMs: number): Promise<void> {
  if (starting || capture) return // never open a second microphone session
  starting = true
  try {
    playback = new Playback((r) => engine.playback(r))
    capture = await MicCapture.open({
      muted,
      bargeInMs,
      isPlaying: () => !!playback?.isPlaying(),
      onBargeIn: () => engine.bargeIn(),
      onFrame: (pcm) => engine.mic(pcm),
      onSpeech: (speaking) => {
        // Duck instantly (no round trip) so the user can speak; main decides whether it was real.
        if (speaking && playback?.isPlaying()) playback.duck(true)
        engine.vad(speaking)
      },
      onFatal: (err) => engine.error(err)
    })
    engine.ready()
  } catch (err) {
    teardown()
    engine.error(err instanceof EngineFailure ? err.info : describeMicError(err))
  } finally {
    starting = false
  }
}

function teardown(): void {
  capture?.close()
  capture = null
  playback?.close()
  playback = null
}

unsubscribe.push(
  engine.onStart(({ muted, bargeInMs }) => void start(muted, bargeInMs)),
  engine.onStop(() => teardown()),
  engine.onMute((m) => capture?.setMuted(m)),
  engine.onAudio((id, pcm) => playback?.enqueue(id, pcm)),
  engine.onMarker((id, seg) => playback?.marker(id, seg)),
  engine.onDone((id) => playback?.done(id)),
  engine.onClear((id) => playback?.clear(id)),
  engine.onDuck((on) => playback?.duck(on))
)

window.addEventListener('pagehide', () => {
  teardown()
  unsubscribe.forEach((off) => off())
})
