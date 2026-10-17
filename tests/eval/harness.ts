import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import Anthropic from '@anthropic-ai/sdk'
import { StudyMaterial } from '../../src/main/study/studyMaterial'
import { ClaudeChat } from '../../src/main/voice/claude'
import { readVoiceConfig, type VoiceConfig } from '../../src/main/voice/config'
import type { EnginePort, SttHooks, TtsPort } from '../../src/main/voice/ports'
import { VoiceSession } from '../../src/main/voice/session'
import { DeepgramTts } from '../../src/main/voice/tts'
import { TTS_SAMPLE_RATE, type TranscriptEntry, type VoiceEvent } from '../../src/shared/voice'
import { renderReport } from './report'

// Runs a fixed question set through ECHO's real pipeline (session, prompts, routing, Claude, speech chunking and
// Deepgram TTS) once per configuration variant, and keeps what came out: the spoken text, the audio, timings and
// automatic checks. Only the microphone and speaker are simulated. Used by quality.eval.test.ts (real services, costs
// money) and harness.test.ts (local fakes).

export interface EvalTurn {
  /** What the learner says. Replaced by the transcript of `audio` when that recording exists. */
  say: string
  /** A recording of the question (16 kHz mono WAV), transcribed with Deepgram, so recognition is tested too. */
  audio?: string
  /** Simulated low-confidence words for text turns: [word, confidence]. */
  unsure?: Array<[string, number]>
}

export interface EvalQuestion {
  id: string
  category: string
  turns: EvalTurn[]
  /** Study files (relative to the eval folder) loaded before the question. */
  study?: string[]
  /** Checked on the reply to the last turn. */
  expect?: {
    tier?: 'fast' | 'strong'
    /** Regular expressions (case-insensitive) the reply must match. */
    mentions?: string[]
    /** The reply should ask the learner something back. */
    asksBack?: boolean
    maxWords?: number
    /** The reply should cite at least one web source. */
    cites?: boolean
  }
}

export interface EvalVariant {
  name: string
  description: string
  env: Record<string, string>
}

export interface Check {
  name: string
  ok: boolean
  detail?: string
}

export interface TurnResult {
  heard: string
  /** What Deepgram transcribed from the recording, and its word error rate against `say`. */
  transcribed?: { text: string; wer: number }
  spoken: string
  words: number
  model: string | null
  tier: string | null
  searches: number
  fetches: number
  sources: Array<{ title: string; url: string; cited: boolean }>
  flushes: number
  firstTextMs: number | null
  firstAudioMs: number | null
  totalMs: number
  audioSeconds: number
  audioFile: string | null
  error?: string
}

export interface QuestionResult {
  id: string
  category: string
  variant: string
  turns: TurnResult[]
  checks: Check[]
}

export interface EvalRun {
  startedAt: string
  variants: EvalVariant[]
  questions: EvalQuestion[]
  results: QuestionResult[]
}

export interface EvalOptions {
  questions: EvalQuestion[]
  variants: EvalVariant[]
  /** The environment the variants' overrides are applied on (keys, models). */
  baseEnv: NodeJS.ProcessEnv
  outDir: string
  /** Folder that question `audio` and `study` paths are relative to. */
  root: string
  /** Point the Anthropic client somewhere else (tests). */
  anthropicBaseUrl?: string
  /** Transcribe recordings with Deepgram's pre-recorded API (off in tests). */
  transcribe?: (wav: Buffer, cfg: VoiceConfig) => Promise<{ text: string; words: Array<{ word: string; confidence: number }> }>
  replyTimeoutMs?: number
  onProgress?(line: string): void
}

const wordsOf = (s: string): string[] => s.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? []

/** Word error rate: word-level edit distance over the reference length. */
export function wordErrorRate(reference: string, hypothesis: string): number {
  const r = wordsOf(reference)
  const h = wordsOf(hypothesis)
  if (!r.length) return h.length ? 1 : 0
  const d = Array.from({ length: r.length + 1 }, (_, i) => [i, ...Array<number>(h.length).fill(0)])
  for (let j = 1; j <= h.length; j++) d[0][j] = j
  for (let i = 1; i <= r.length; i++) {
    for (let j = 1; j <= h.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1))
    }
  }
  return Math.round((d[r.length][h.length] / r.length) * 1000) / 1000
}

export function wav(pcm: Buffer, rate = TTS_SAMPLE_RATE): Buffer {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * 2, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

/** Deepgram pre-recorded transcription (nova-3), for questions that come with a recording. */
export async function deepgramTranscribe(wavData: Buffer, cfg: VoiceConfig): Promise<{ text: string; words: Array<{ word: string; confidence: number }> }> {
  const base = cfg.deepgramBase.replace(/^ws/, 'http')
  const res = await fetch(`${base}/v1/listen?model=nova-3&smart_format=true`, {
    method: 'POST',
    headers: { Authorization: `Token ${cfg.deepgramApiKey}`, 'Content-Type': 'audio/wav' },
    body: new Uint8Array(wavData)
  })
  if (!res.ok) throw new Error(`Deepgram transcription failed (HTTP ${res.status})`)
  const json = (await res.json()) as { results?: { channels?: Array<{ alternatives?: Array<{ transcript?: string; words?: Array<{ word: string; punctuated_word?: string; confidence: number }> }> }> } }
  const alt = json.results?.channels?.[0]?.alternatives?.[0]
  return { text: alt?.transcript ?? '', words: (alt?.words ?? []).map((w) => ({ word: w.punctuated_word ?? w.word, confidence: w.confidence })) }
}

export function runChecks(q: EvalQuestion, t: TurnResult | undefined): Check[] {
  const e = q.expect ?? {}
  if (!t) return [{ name: 'answered', ok: false, detail: 'no reply' }]
  const checks: Check[] = [{ name: 'answered', ok: !t.error && t.words > 0, ...(t.error ? { detail: t.error } : {}) }]
  if (e.tier) checks.push({ name: `model tier ${e.tier}`, ok: t.tier === e.tier, detail: `routed ${t.tier ?? 'unknown'} (${t.model ?? '?'})` })
  for (const m of e.mentions ?? []) checks.push({ name: `mentions /${m}/`, ok: new RegExp(m, 'i').test(t.spoken) })
  if (e.asksBack) {
    const lastSentences = t.spoken.split(/(?<=[.!?])\s+/).slice(-2).join(' ')
    checks.push({ name: 'asks back', ok: lastSentences.includes('?') })
  }
  if (e.maxWords) checks.push({ name: `at most ${e.maxWords} words`, ok: t.words <= e.maxWords, detail: `${t.words} words` })
  if (e.cites) checks.push({ name: 'cites a web source', ok: t.sources.some((s) => s.cited), detail: `${t.sources.filter((s) => s.cited).length} cited` })
  return checks
}

/** Plays back instantly: audio is kept per reply, and each reply is reported finished once its audio is in. */
class RecordingEngine implements EnginePort {
  session: VoiceSession | null = null
  audio = new Map<string, Buffer[]>()
  markers = new Map<string, number>()
  start(): void {}
  stop(): void {}
  setMuted(): void {}
  duck(): void {}
  sendAudio(id: string, pcm: Buffer): void {
    const parts = this.audio.get(id) ?? []
    if (!parts.length) this.session?.onPlayback({ kind: 'started', responseId: id, at: Date.now() })
    parts.push(Buffer.from(pcm))
    this.audio.set(id, parts)
  }
  segmentMarker(id: string, segment: number): void {
    this.markers.set(id, Math.max(this.markers.get(id) ?? -1, segment))
  }
  responseDone(id: string): void {
    const last = this.markers.get(id) ?? -1
    for (let s = 0; s <= last; s++) this.session?.onPlayback({ kind: 'segment', responseId: id, segment: s, at: Date.now() })
    this.session?.onPlayback({ kind: 'ended', responseId: id, at: Date.now() })
  }
  clearPlayback(): void {}
}

/** Counts flushes on the real TTS client (each flush is voiced as one unit). */
function countingTts(inner: TtsPort, counter: { flushes: number }): TtsPort {
  return {
    ensureConnected: () => inner.ensureConnected(),
    begin: (id) => {
      counter.flushes = 0
      inner.begin(id)
    },
    speak: (t) => inner.speak(t),
    canFlush: () => inner.canFlush(),
    flush: () => {
      counter.flushes += 1
      return inner.flush()
    },
    clear: () => inner.clear(),
    close: () => inner.close()
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function runQuestion(q: EvalQuestion, variant: EvalVariant, cfg: VoiceConfig, chat: ClaudeChat, logs: string[], opts: EvalOptions): Promise<QuestionResult> {
  const engine = new RecordingEngine()
  const counter = { flushes: 0 }
  const events: VoiceEvent[] = []
  let hooks: SttHooks | null = null
  let tts: TtsPort | null = null
  let study: StudyMaterial | undefined
  if (q.study?.length) {
    study = new StudyMaterial('eval-study.json', { read: () => null, write: () => {} }, undefined, (m) => logs.push(m))
    for (const f of q.study) await study.add(resolve(opts.root, f), false)
  }
  const session = new VoiceSession({
    config: cfg,
    engine,
    chat,
    createStt: (h) => ((hooks = h), { connect() {}, sendAudio() {}, forceEndTurn() {}, close() {} }),
    createTts: (h) => (tts = countingTts(new DeepgramTts(cfg, h), counter)),
    emit: (e) => events.push(e),
    ...(study ? { study } : {}),
    log: (m) => logs.push(m)
  })
  engine.session = session
  session.start()
  session.onEngineReady()
  hooks!.onStatus({ kind: 'connected' })

  const turns: TurnResult[] = []
  try {
    for (const [i, turn] of q.turns.entries()) {
      let heard = turn.say
      let words = turn.unsure ? heard.split(/\s+/).map((w) => ({ word: w, confidence: turn.unsure!.find(([u]) => w.replace(/\W/g, '') === u)?.[1] ?? 0.98 })) : undefined
      let transcribed: TurnResult['transcribed']
      // A recording dropped in as recordings/<id>.wav (or <id>-<turn>.wav) is used without editing the question list.
      const recorded = [turn.audio, `recordings/${q.id}${q.turns.length > 1 ? `-${i + 1}` : ''}.wav`].find((p): p is string => !!p && existsSync(resolve(opts.root, p)))
      if (recorded && opts.transcribe) {
        const audioPath = resolve(opts.root, recorded)
        try {
          const t = await opts.transcribe(readFileSync(audioPath), cfg)
          heard = t.text || turn.say
          words = t.words
          transcribed = { text: t.text, wer: wordErrorRate(turn.say, t.text) }
        } catch (err) {
          logs.push(`[eval] could not transcribe ${recorded}: ${err instanceof Error ? err.message : err}`)
        }
      }
      const logStart = logs.length
      const before = session.getEntries().filter((e) => e.role === 'assistant').length
      const t0 = Date.now()
      hooks!.onTurn({ event: 'StartOfTurn', transcript: heard.split(' ')[0], turnIndex: i })
      hooks!.onTurn({ event: 'EndOfTurn', transcript: heard, turnIndex: i, ...(words ? { words } : {}) })
      let entry: TranscriptEntry | undefined
      const deadline = t0 + (opts.replyTimeoutMs ?? 120_000)
      for (;;) {
        const replies = session.getEntries().filter((e) => e.role === 'assistant')
        entry = replies.length > before ? replies.at(-1) : undefined
        const snapshot = session.getSnapshot()
        if ((entry?.final && snapshot.state !== 'thinking' && snapshot.state !== 'speaking') || snapshot.state === 'error' || Date.now() > deadline) break
        await sleep(25)
      }
      const totalMs = Date.now() - t0
      const turnLogs = logs.slice(logStart).join('\n')
      const metrics = events.flatMap((e) => (e.type === 'metrics' && e.metrics.responseId === entry?.id ? [e.metrics] : []))
      const firstText = metrics.find((m) => m.firstClaudeText !== undefined)?.firstClaudeText ?? null
      const firstAudio = metrics.find((m) => m.firstAudioPlayed !== undefined)?.firstAudioPlayed ?? null
      const pcm = entry ? Buffer.concat(engine.audio.get(entry.id) ?? []) : Buffer.alloc(0)
      let audioFile: string | null = null
      if (pcm.length) {
        const rel = join('audio', variant.name, `${q.id}${q.turns.length > 1 ? `-${i + 1}` : ''}.wav`)
        mkdirSync(join(opts.outDir, 'audio', variant.name), { recursive: true })
        writeFileSync(join(opts.outDir, rel), wav(pcm))
        audioFile = rel
      }
      const spoken = entry?.text ?? ''
      const sum = (re: RegExp): number => [...turnLogs.matchAll(re)].reduce((n, m) => n + Number(m[1]), 0)
      turns.push({
        heard,
        ...(transcribed ? { transcribed } : {}),
        spoken,
        words: spoken.split(/\s+/).filter(Boolean).length,
        model: [...turnLogs.matchAll(/\[claude\] model \S+→(\S+)/g)].at(-1)?.[1] ?? null,
        tier: /\[voice\] model route: (fast|strong)/.exec(turnLogs)?.[1] ?? (/\[claude\] model \S+→/.test(turnLogs) ? 'deep' : null),
        searches: sum(/searches=(\d+)/g),
        fetches: sum(/fetches=(\d+)/g),
        sources: entry?.sources ?? [],
        flushes: counter.flushes,
        firstTextMs: firstText,
        firstAudioMs: firstAudio,
        totalMs,
        audioSeconds: Math.round((pcm.length / 2 / TTS_SAMPLE_RATE) * 10) / 10,
        audioFile,
        ...(session.getSnapshot().state === 'error' ? { error: session.getSnapshot().message ?? 'error' } : !entry?.final ? { error: 'timed out' } : {})
      })
    }
  } finally {
    session.stop()
    ;(tts as TtsPort | null)?.close()
  }
  return { id: q.id, category: q.category, variant: variant.name, turns, checks: runChecks(q, turns.at(-1)) }
}

export async function runEval(opts: EvalOptions): Promise<EvalRun> {
  mkdirSync(opts.outDir, { recursive: true })
  const run: EvalRun = { startedAt: new Date().toISOString(), variants: opts.variants, questions: opts.questions, results: [] }
  for (const variant of opts.variants) {
    const parsed = readVoiceConfig({ ...opts.baseEnv, ECHO_LOG_METRICS: 'true', ...variant.env })
    if (!parsed.ok) throw new Error(parsed.message)
    const cfg = parsed.config
    const logs: string[] = []
    const client = new Anthropic({
      apiKey: cfg.anthropicApiKey,
      maxRetries: 1,
      ...(opts.anthropicBaseUrl ? { baseURL: opts.anthropicBaseUrl } : {}),
      ...(cfg.anthropicWorkspaceId ? { defaultHeaders: { 'anthropic-workspace-id': cfg.anthropicWorkspaceId } } : {})
    })
    const chat = new ClaudeChat(cfg, client, (m) => logs.push(m))
    for (const q of opts.questions) {
      const result = await runQuestion(q, variant, cfg, chat, logs, opts)
      run.results.push(result)
      const failed = result.checks.filter((c) => !c.ok).map((c) => c.name)
      opts.onProgress?.(`[${variant.name}] ${q.id}: ${failed.length ? `FAIL ${failed.join(', ')}` : 'ok'} (${result.turns.at(-1)?.firstAudioMs ?? '?'} ms to first audio)`)
    }
  }
  writeFileSync(join(opts.outDir, 'results.json'), JSON.stringify(run, null, 2))
  writeFileSync(join(opts.outDir, 'report.html'), renderReport(run))
  return run
}
