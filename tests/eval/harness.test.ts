import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
// @ts-expect-error The e2e fakes are plain JavaScript.
import { startFakes } from '../e2e/fake-services.mjs'
import { runChecks, runEval, wordErrorRate, type EvalQuestion } from './harness'

// The eval harness end to end against the local stand-ins for Anthropic and Deepgram (no network, no cost): real
// session, real Claude client, real Deepgram TTS client, real audio frames written to WAV.

describe('eval harness', () => {
  let fakes: { port: number; log: { claude: { requests: Array<Record<string, unknown>> }; tts: { flushes: number } }; close(): Promise<void> }
  beforeAll(async () => {
    fakes = await startFakes({
      replyText: ['A hash map stores values under keys. ', 'Collisions share a slot.'],
      tokenDelayMs: 2,
      autoTurns: false
    })
  })
  afterAll(async () => fakes?.close())

  it('runs questions per variant and writes audio, results and a listening report', { timeout: 30_000 }, async () => {
    const outDir = mkdtempSync(join(tmpdir(), 'echo-eval-'))
    const questions: EvalQuestion[] = [
      { id: 'hash-map', category: 'concept', turns: [{ say: 'How does a hash map work?' }], expect: { tier: 'fast', mentions: ['hash'], maxWords: 80 } },
      { id: 'two-turns', category: 'follow-up', turns: [{ say: 'What is a hash map?' }, { say: 'Why is my hash map lookup slow?' }], expect: { tier: 'strong', mentions: ['collision'] } }
    ]
    const run = await runEval({
      questions,
      variants: [
        { name: 'baseline', description: 'defaults', env: {} },
        { name: 'small-pieces', description: 'old chunking', env: { ECHO_TTS_FIRST_CHARS: '18', ECHO_TTS_GROUP_CHARS: '140' } }
      ],
      baseEnv: { ANTHROPIC_API_KEY: 'test-anthropic-key', DEEPGRAM_API_KEY: 'test-deepgram-key', ECHO_DEEPGRAM_WS_BASE: `ws://127.0.0.1:${fakes.port}`, ECHO_WEB_SEARCH: 'false' },
      anthropicBaseUrl: `http://127.0.0.1:${fakes.port}`,
      outDir,
      root: outDir
    })

    expect(run.results.map((r) => `${r.variant}/${r.id}`)).toEqual(['baseline/hash-map', 'baseline/two-turns', 'small-pieces/hash-map', 'small-pieces/two-turns'])
    const first = run.results[0].turns[0]
    expect(first.spoken).toContain('A hash map stores values under keys.')
    expect(first.model).toBe('claude-haiku-5-5')
    expect(first.tier).toBe('fast')
    expect(first.firstAudioMs).toBeGreaterThan(0)
    expect(first.audioSeconds).toBeGreaterThan(1)
    expect(existsSync(join(outDir, first.audioFile!))).toBe(true)
    expect(readFileSync(join(outDir, first.audioFile!)).subarray(0, 4).toString()).toBe('RIFF')
    expect(run.results[0].checks.every((c) => c.ok)).toBe(true)

    // The follow-up is a hard question, so it is routed to the strong model.
    const followUp = run.results[1]
    expect(followUp.turns).toHaveLength(2)
    expect(followUp.turns[1].tier).toBe('strong')
    expect(followUp.turns[1].model).toBe('claude-sonnet-5-5')

    expect(run.results[0].turns[0].flushes).toBeGreaterThan(0)

    const report = readFileSync(join(outDir, 'report.html'), 'utf8')
    expect(report).toContain('<audio controls preload="none" src="audio/baseline/hash-map.wav">')
    expect(report).toContain('Blind listening')
    expect(JSON.parse(readFileSync(join(outDir, 'results.json'), 'utf8')).results).toHaveLength(4)
  })

  it('scores transcripts and replies', () => {
    expect(wordErrorRate('how does a CPU cache work', 'how does a CPU cash work')).toBeCloseTo(1 / 6, 3)
    const turn = { heard: '', spoken: 'Did you mean cache, as in CPU memory?', words: 7, model: 'm', tier: 'fast', searches: 0, fetches: 0, sources: [], flushes: 1, firstTextMs: 1, firstAudioMs: 2, totalMs: 3, audioSeconds: 1, audioFile: null }
    const checks = runChecks({ id: 'x', category: 'c', turns: [{ say: 'q' }], expect: { mentions: ['cache'], asksBack: true, maxWords: 10, tier: 'strong' } }, turn)
    expect(checks.map((c) => [c.name, c.ok])).toEqual([['answered', true], ['model tier strong', false], ['mentions /cache/', true], ['asks back', true], ['at most 10 words', true]])
  })
})
