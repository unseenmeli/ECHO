// Live comparison against the real API: a minimal text-only call versus ECHO's full pipeline (prompting, routing,
// parsing, speech chunking). Costs a few cents on the configured key, so it only runs when asked:
//
//   ECHO_LIVE=1 npx vitest run tests/live
//
// Prints a short report. Never prints the key or screen content (no screen is shared here).
import { writeFileSync } from 'node:fs'
import Anthropic from '@anthropic-ai/sdk'
import { describe, expect, it } from 'vitest'
import { SegmentStreamParser } from '../../src/main/lesson/tutorProtocol'
import { ClaudeChat } from '../../src/main/voice/claude'
import { loadEnvFiles, readVoiceConfig } from '../../src/main/voice/config'
import { ROUTER_SYSTEM } from '../../src/main/voice/intent'
import { SUMMARY_SYSTEM } from '../../src/main/voice/history'
import type { ChatPort, ChatRequest, EnginePort, SttHooks, TtsHooks, TtsPort } from '../../src/main/voice/ports'
import { VoiceSession } from '../../src/main/voice/session'
import { FakeBoard, until } from '../helpers/lesson-fakes'

const engine: EnginePort = { start() {}, stop() {}, setMuted() {}, sendAudio() {}, segmentMarker() {}, responseDone() {}, clearPlayback() {}, duck() {} }

class SilentTts implements TtsPort {
  constructor(readonly hooks: TtsHooks) {}
  ensureConnected(): void {}
  begin(): void {}
  speak(): void {}
  canFlush(): boolean {
    return true
  }
  private n = 0
  flush(): number {
    return this.n++
  }
  clear(): void {}
  close(): void {}
}

/** Passes requests to the real client and keeps the raw text of tutor replies (not routing or summaries). */
class Recorder implements ChatPort {
  tutor: Array<{ raw: string; ms: number; firstMs: number | null }> = []
  constructor(private readonly inner: ChatPort) {}
  async stream(req: ChatRequest): Promise<void> {
    const isTutor = req.system !== ROUTER_SYSTEM && req.system !== SUMMARY_SYSTEM
    const rec = { raw: '', ms: 0, firstMs: null as number | null }
    const t0 = Date.now()
    try {
      await this.inner.stream({
        ...req,
        onText: (d) => {
          rec.firstMs ??= Date.now() - t0
          rec.raw += d
          req.onText(d)
        }
      })
    } finally {
      rec.ms = Date.now() - t0
      if (isTutor) this.tutor.push(rec)
    }
  }
}

loadEnvFiles([process.cwd()])
const cfg = readVoiceConfig()
const live = process.env.ECHO_LIVE === '1' && cfg.ok

describe.skipIf(!live)('live: minimal call vs the ECHO pipeline', () => {
  it('compares answers, follow-ups, search, a calculation and a whiteboard turn', { timeout: 240_000 }, async () => {
    if (!cfg.ok) return
    const config = cfg.config
    const log: string[] = []
    const report: string[] = []
    const client = new Anthropic({
      apiKey: config.anthropicApiKey,
      maxRetries: 1,
      ...(config.anthropicWorkspaceId ? { defaultHeaders: { 'anthropic-workspace-id': config.anthropicWorkspaceId } } : {})
    })
    const chat = new Recorder(new ClaudeChat(config, client, (m) => log.push(m)))

    let whiteboard = false
    const board = new FakeBoard([])
    let hooks: SttHooks | null = null
    const session = new VoiceSession({
      config,
      engine,
      chat,
      lesson: { available: () => whiteboard, board: () => (whiteboard ? board : null) },
      createStt: (h) => ((hooks = h), { connect() {}, sendAudio() {}, forceEndTurn() {}, close() {} }),
      createTts: (h) => new SilentTts(h),
      emit: () => {},
      log: (m) => log.push(m)
    })
    session.start()
    session.onEngineReady()
    hooks!.onStatus({ kind: 'connected' })
    let turn = 0
    const ask = async (text: string): Promise<{ spoken: string; raw: string; ms: number; firstMs: number | null }> => {
      const before = chat.tutor.length
      hooks!.onTurn({ event: 'StartOfTurn', transcript: text, turnIndex: turn })
      hooks!.onTurn({ event: 'EndOfTurn', transcript: text, turnIndex: turn++ })
      await until(() => chat.tutor.length > before, 120_000)
      const entries = session.getEntries().filter((e) => e.role === 'assistant')
      const last = entries.at(-1)!
      // Let the (silent) playback finish so the reply is committed to history like in the app.
      for (let i = 0; i < 40; i++) session.onPlayback({ kind: 'segment', responseId: last.id, segment: i, at: Date.now() })
      session.onPlayback({ kind: 'ended', responseId: last.id, at: Date.now() })
      const rec = chat.tutor.at(-1)!
      return { spoken: last.text, raw: rec.raw, ms: rec.ms, firstMs: rec.firstMs }
    }
    const minimal = async (q: string): Promise<{ text: string; ms: number; model: string }> => {
      const t0 = Date.now()
      const r = await client.messages.create({ model: config.claudeModel, max_tokens: 600, messages: [{ role: 'user', content: q }] })
      return { text: r.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join(''), ms: Date.now() - t0, model: r.model }
    }
    const words = (s: string): number => s.split(/\s+/).filter(Boolean).length

    // 1. A plain question: what minimal prompting gives versus what ECHO says aloud.
    const q1 = 'Why is the sky blue?'
    const m1 = await minimal(q1)
    const e1 = await ask(q1)
    report.push(`Q1 minimal (${m1.model}, ${m1.ms} ms, ${words(m1.text)} words): ${m1.text.slice(0, 400)}`)
    report.push(`Q1 ECHO spoken (${e1.ms} ms, first text ${e1.firstMs} ms, ${words(e1.spoken)} words): ${e1.spoken}`)
    report.push(`Q1 raw vs spoken lost: ${words(e1.raw) - words(e1.spoken)} words`)

    // 2. A follow-up that only makes sense with the previous turn.
    const e2 = await ask('And why is it red at sunset then?')
    report.push(`Q2 follow-up spoken: ${e2.spoken}`)

    // 3. Current information: should search and cite.
    const e3 = await ask('What is the latest LTS version of Node.js right now?')
    const entry3 = session.getEntries().filter((e) => e.role === 'assistant').at(-1)!
    report.push(`Q3 search spoken: ${e3.spoken}`)
    report.push(`Q3 sources: ${(entry3.sources ?? []).map((s) => `${s.cited ? '' : '(found) '}${s.title} <${s.url}>`).join(' | ') || 'none'}${entry3.searchFailed ? ' [search failed]' : ''}`)

    // 4. A calculation worth verifying.
    const e4 = await ask('If I invest 2400 dollars at 6.5 percent a year compounded monthly, how much do I have after 7 years?')
    report.push(`Q4 calc spoken: ${e4.spoken}`)

    // 5. A whiteboard turn: how much of the raw protocol output survives parsing.
    whiteboard = true
    const e5 = await ask('How does a CPU cache work?')
    const parser = new SegmentStreamParser()
    const segs = [...parser.push(e5.raw), ...parser.end()]
    const drawErrors = segs.filter((s) => s.drawing?.error).map((s) => s.drawing!.error)
    report.push(`Q5 lesson: ${segs.length} segments parsed, ${segs.filter((s) => s.drawing?.plan).length} drawings valid, errors: ${drawErrors.join('; ') || 'none'}, board batches: ${board.batches.length}`)
    report.push(`Q5 spoken: ${e5.spoken.slice(0, 500)}`)

    report.push('--- request log (ids, counts, usage only) ---', ...log.filter((l) => /\[claude\]|skills|route|web search/.test(l)))
    if (process.env.ECHO_LIVE_REPORT) writeFileSync(process.env.ECHO_LIVE_REPORT, report.join('\n') + '\n')
    else console.log('\n' + report.join('\n') + '\n')
    session.stop()

    expect(e1.spoken.length).toBeGreaterThan(20)
    expect(log.some((l) => /cache_read=[1-9]/.test(l))).toBe(true)
  })
})
