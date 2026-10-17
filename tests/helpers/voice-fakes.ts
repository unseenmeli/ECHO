import { readVoiceConfig, type VoiceConfig } from '../../src/main/voice/config'
import type { ChatPort, ChatRequest, EnginePort, SttHooks, SttPort, TtsHooks, TtsPort, TurnInfo } from '../../src/main/voice/ports'
import { VoiceSession, type SessionDeps } from '../../src/main/voice/session'

// Minimal stand-ins for driving a VoiceSession turn by turn and reading what it sent to the model.

export class FakeStt implements SttPort {
  constructor(readonly hooks: SttHooks) {}
  connect(): void {}
  sendAudio(): void {}
  forceEndTurn(): void {}
  close(): void {}
  turn(event: TurnInfo['event'], transcript: string, turnIndex = 0, words?: TurnInfo['words']): void {
    this.hooks.onTurn({ event, transcript, turnIndex, ...(words ? { words } : {}) })
  }
}

export class SpokenTts implements TtsPort {
  spoken: string[] = []
  private n = 0
  constructor(readonly hooks: TtsHooks) {}
  ensureConnected(): void {}
  begin(): void {}
  speak(text: string): void {
    this.spoken.push(text)
  }
  canFlush(): boolean {
    return true
  }
  flush(): number {
    return this.n++
  }
  clear(): void {}
  close(): void {}
}

export const silentEngine: EnginePort = { start() {}, stop() {}, setMuted() {}, sendAudio() {}, segmentMarker() {}, responseDone() {}, clearPlayback() {}, duck() {} }

/** Records every request and answers each with the same short line. */
export class RecordingChat implements ChatPort {
  calls: ChatRequest[] = []
  constructor(private readonly answer = 'Here is the answer.') {}
  async stream(req: ChatRequest): Promise<void> {
    this.calls.push(req)
    req.onText(this.answer)
  }
}

export function voiceConfig(env: Record<string, string> = {}): VoiceConfig {
  const cfg = readVoiceConfig({ ANTHROPIC_API_KEY: 'k', DEEPGRAM_API_KEY: 'd', ...env })
  if (!cfg.ok) throw new Error('config')
  return cfg.config
}

/** A started, connected session whose turns are driven through `stt`. */
export function voiceSession(extra: Partial<SessionDeps> = {}, env: Record<string, string> = {}) {
  const chat = (extra.chat as RecordingChat | undefined) ?? new RecordingChat()
  const stts: FakeStt[] = []
  const ttss: SpokenTts[] = []
  const session = new VoiceSession({
    config: voiceConfig(env),
    engine: silentEngine,
    chat,
    createStt: (h) => (stts.push(new FakeStt(h)), stts.at(-1)!),
    createTts: (h) => (ttss.push(new SpokenTts(h)), ttss.at(-1)!),
    emit: () => {},
    log: () => {},
    ...extra
  })
  session.start()
  session.onEngineReady()
  stts[0].hooks.onStatus({ kind: 'connected' })
  return { session, chat, stt: stts[0], tts: () => ttss.at(-1)! }
}
