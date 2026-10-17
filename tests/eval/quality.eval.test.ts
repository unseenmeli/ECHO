// The quality evaluation against the REAL services: every question in questions.json through ECHO's full pipeline,
// once per variant, with the audio saved for listening. It sends the questions to Anthropic and Deepgram and costs
// money (roughly one short conversation per question per variant), so it only runs when asked:
//
//   npm run eval                                      (variants: baseline, small-pieces)
//   ECHO_EVAL_VARIANTS=baseline,voice-helena npm run eval
//   ECHO_EVAL_QUESTIONS=misheard-cache,tcp-udp npm run eval
//
// Open tests/eval/out/<time>/report.html afterwards. See tests/eval/README.md.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadEnvFiles } from '../../src/main/voice/config'
import { deepgramTranscribe, runEval, type EvalQuestion, type EvalVariant } from './harness'

const here = join(process.cwd(), 'tests', 'eval')
loadEnvFiles([process.cwd()])
const enabled = process.env.ECHO_EVAL === '1'

describe.skipIf(!enabled)('quality eval (real services)', () => {
  it('runs the question set for each variant and writes the report', { timeout: 60 * 60 * 1000 }, async () => {
    const pick = <T extends { id?: string; name?: string }>(all: T[], wanted: string | undefined, fallback: string[]): T[] => {
      const names = wanted ? wanted.split(',').map((s) => s.trim()).filter(Boolean) : fallback
      if (!names.length) return all
      const out = names.map((n) => all.find((x) => (x.id ?? x.name) === n) ?? (() => { throw new Error(`unknown: ${n}`) })())
      return out
    }
    const allQuestions = JSON.parse(readFileSync(join(here, 'questions.json'), 'utf8')) as EvalQuestion[]
    const allVariants = JSON.parse(readFileSync(join(here, 'variants.json'), 'utf8')) as EvalVariant[]
    const questions = pick(allQuestions, process.env.ECHO_EVAL_QUESTIONS, [])
    const variants = pick(allVariants, process.env.ECHO_EVAL_VARIANTS, ['baseline', 'small-pieces'])
    const outDir = join(here, 'out', new Date().toISOString().replace(/[:.]/g, '-'))
    console.log(`[eval] ${questions.length} questions × ${variants.length} variants (${variants.map((v) => v.name).join(', ')}) → ${outDir}`)
    const run = await runEval({ questions, variants, baseEnv: process.env, outDir, root: here, transcribe: deepgramTranscribe, onProgress: (l) => console.log(l) })
    const checks = run.results.flatMap((r) => r.checks)
    console.log(`[eval] checks passed: ${checks.filter((c) => c.ok).length}/${checks.length}. Report: ${join(outDir, 'report.html')}`)
    expect(run.results).toHaveLength(questions.length * variants.length)
  })
})
