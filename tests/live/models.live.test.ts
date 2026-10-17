// Model benchmark for the quality-first route: difficult questions through ECHO's real request path (ClaudeChat, the
// tutor prompt, the lesson protocol and instruction packs), once per candidate model and effort. Measures time to the
// first word, total time and length, and has a blind judge score each answer against reference notes. It costs real
// money and takes a while (every candidate answers every question), so it only runs when asked:
//
//   ECHO_LIVE=1 npx vitest run tests/live/models.live.test.ts
//   ECHO_BENCH_CANDIDATES=opus-high,fable-high ECHO_LIVE=1 npx vitest run tests/live/models.live.test.ts
//
// The report lands in tests/live/out/. It never contains the API key.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import Anthropic from '@anthropic-ai/sdk'
import { describe, expect, it } from 'vitest'
import { SegmentStreamParser } from '../../src/main/lesson/tutorProtocol'
import { LESSON_PROMPT_ADDENDUM } from '../../src/main/lesson/tutorProtocol'
import { selectSkills, skillsPrompt } from '../../src/main/skills'
import { buildSystemPrompt, buildTurnContext, ClaudeChat } from '../../src/main/voice/claude'
import { loadEnvFiles, readVoiceConfig, type VoiceConfig } from '../../src/main/voice/config'
import type { ChatMessage } from '../../src/main/voice/history'
import type { Effort, ScreenImage } from '../../src/main/voice/ports'

loadEnvFiles([process.cwd()])
const base = readVoiceConfig()
const live = process.env.ECHO_LIVE === '1' && base.ok

interface Candidate {
  name: string
  model: string
  reasoning: 'off' | 'adaptive'
  effort: Effort
}

const CANDIDATES: Candidate[] = [
  { name: 'haiku-fast', model: 'claude-haiku-5-5', reasoning: 'off', effort: 'low' }, // the fast route, as a floor
  { name: 'sonnet-nothink', model: 'claude-sonnet-5-5', reasoning: 'off', effort: 'medium' }, // the old strong route
  { name: 'sonnet-high', model: 'claude-sonnet-5-5', reasoning: 'adaptive', effort: 'high' },
  { name: 'opus-medium', model: 'claude-opus-5-5', reasoning: 'adaptive', effort: 'medium' },
  { name: 'opus-high', model: 'claude-opus-5-5', reasoning: 'adaptive', effort: 'high' },
  { name: 'fable-medium', model: 'claude-fable-5-1', reasoning: 'adaptive', effort: 'medium' },
  { name: 'fable-high', model: 'claude-fable-5-1', reasoning: 'adaptive', effort: 'high' }
]

const JUDGE_MODEL = process.env.ECHO_BENCH_JUDGE?.trim() || 'claude-fable-5-1'
const BST_IMAGE = 'https://upload.wikimedia.org/wikipedia/commons/thumb/d/da/Binary_search_tree.svg/800px-Binary_search_tree.svg.png'

interface Question {
  id: string
  kind: 'reasoning' | 'misconception' | 'visual' | 'lesson'
  turns: ChatMessage[]
  reference: string
  /** Sends the picture as the shared screen. */
  screen?: boolean
  /** Taught on the whiteboard as a deep dive (lesson protocol and packs). */
  lesson?: boolean
}

const ask = (say: string): ChatMessage[] => [{ role: 'user', content: say }]

const QUESTIONS: Question[] = [
  {
    id: 'debug-average',
    kind: 'reasoning',
    turns: ask('My Python function average returns sum of xs divided by len of xs. It crashes for some inputs, and on an old server it said the average of 1 and 2 is 1. What is going on?'),
    reference: 'Two bugs. An empty list gives len 0, so ZeroDivisionError; guard for it. The old server runs Python 2, where / between integers is floor division, so 3/2 is 1; use float division (or Python 3, or from __future__ import division).'
  },
  {
    id: 'dice-conditional',
    kind: 'reasoning',
    turns: ask('If I roll two dice, what is the probability that they add up to 8, given that at least one of them shows a 3?'),
    reference: 'Outcomes with at least one 3: 11. Of those, sum 8: (3,5) and (5,3). Answer 2/11, about 18 percent. Common wrong answers: 1/6, 2/36, 1/11.'
  },
  {
    id: 'float-sum',
    kind: 'reasoning',
    turns: ask('Why does 0.1 plus 0.2 not equal 0.3 in JavaScript, and how should I compare them instead?'),
    reference: 'Numbers are IEEE 754 binary doubles; 0.1 and 0.2 have no exact binary representation, so the sum is 0.30000000000000004. Compare with a tolerance (Math.abs(a - b) < Number.EPSILON or a problem-appropriate epsilon), or work in integers (cents) / a decimal library.'
  },
  {
    id: 'build-heap',
    kind: 'reasoning',
    turns: ask('What is the time complexity of building a heap from an unsorted array, and why is it not n log n?'),
    reference: 'O(n) with bottom-up heapify (sift-down from the last internal node). Most nodes are near the leaves and sift down only a few levels: about n/2^(h+1) nodes at height h, each costing O(h), and the sum of h/2^h converges, giving O(n). Inserting one by one would be O(n log n).'
  },
  {
    id: 'trains',
    kind: 'reasoning',
    turns: ask('A train leaves a station at 3 pm going 60 miles an hour. Another leaves the same station at 4 pm going 80 miles an hour in the same direction. When does the second one catch up?'),
    reference: 'At 4 pm the first is 60 miles ahead. The gap closes at 20 mph, so 3 hours: 7 pm, 240 miles from the station.'
  },
  {
    id: 'bfs-queue',
    kind: 'reasoning',
    turns: ask('For breadth-first search, should I use a queue or a stack, and why does swapping it give depth-first search?'),
    reference: 'A FIFO queue: nodes are visited in the order discovered, level by level. A LIFO stack visits the most recently discovered node first, so it dives deep before backtracking, which is depth-first (an iterative DFS). Mark nodes visited to avoid revisiting.'
  },
  {
    id: 'sqrt2-proof',
    kind: 'reasoning',
    turns: ask('Prove that the square root of two is irrational, in a way I could say out loud.'),
    reference: 'Suppose sqrt 2 = a/b in lowest terms. Then a^2 = 2b^2, so a^2 is even, so a is even, a = 2k. Then 4k^2 = 2b^2, so b^2 = 2k^2, so b is even too, contradicting lowest terms. Hence irrational.'
  },
  {
    id: 'seasons-misconception',
    kind: 'misconception',
    turns: [
      { role: 'user', content: 'Why do we have seasons?' },
      { role: 'assistant', content: 'Seasons come from how sunlight reaches different parts of the Earth over the year.' },
      { role: 'user', content: 'Right, so summer is because the Earth is closer to the Sun then?' }
    ],
    reference: 'No: the cause is the 23.4 degree axial tilt, which changes the Sun angle and day length. Earth is actually closest to the Sun (perihelion) in early January, during northern winter, and the hemispheres have opposite seasons at the same distance. Must correct the misconception kindly and clearly.'
  },
  {
    id: 'screen-bst',
    kind: 'visual',
    screen: true,
    turns: ask('What is this diagram on my screen showing, and is it a valid binary search tree?'),
    reference: 'A binary search tree with root 8; left child 3 (children 1 and 6, and 6 has 4 and 7); right child 10, whose right child is 14, whose left child is 13. It is valid: every left subtree is smaller and every right subtree larger. Must describe what is actually in the image.'
  },
  {
    id: 'lesson-public-key',
    kind: 'lesson',
    lesson: true,
    turns: ask('Give me a deep dive on how public-key cryptography lets two strangers agree on a secret over an open network.'),
    reference: 'Should cover the problem (no shared key in advance), key pairs (public/private), a key exchange such as Diffie-Hellman (shared secret from public values; the eavesdropper sees only public values; based on the discrete log problem being hard), then symmetric encryption with the shared key, a concrete worked example (e.g. colour mixing or small numbers), and the man-in-the-middle problem with certificates/signatures as the fix. Narration must stay spoken, and drawings must build up step by step.'
  }
]

const SCREEN_NOTE =
  'The image attached to the user\'s latest message is a live screenshot of their screen, taken as they finished speaking. Use it only when their turn is about what\'s on screen, and then describe only what you can actually see in it.'

const JUDGE_SYSTEM = `You grade answers from ECHO, a spoken voice tutor. You see the learner's conversation, reference notes from an expert, and ECHO's answer (for whiteboard lessons, the spoken narration plus a summary of the drawings). You do not know which model wrote it.
Score 1 to 10:
- Correctness first. Any factual or mathematical error, or a misconception left uncorrected, caps the score at 4.
- Then reasoning: does it explain why, at a depth that fits the question, and address what the learner actually got wrong or asked?
- Then delivery: natural spoken sentences (no Markdown, lists or code dumps), no filler openers, a sensible length for listening.
- For a screen question, it must describe what is actually in the image.
- For a whiteboard lesson, also judge structure (steps that build on each other) and whether the drawings fit the narration.
Reply with only a JSON object: {"score": <1-10>, "correct": <true|false>, "notes": "<one or two sentences>"}`

interface Run {
  candidate: string
  model: string
  question: string
  kind: Question['kind']
  firstTextMs: number | null
  totalMs: number
  words: number
  text: string
  error?: string
  lesson?: { segments: number; drawings: number; drawErrors: string[] }
  judge?: { score: number; correct: boolean; notes: string }
}

async function fetchImage(): Promise<ScreenImage | null> {
  try {
    const res = await fetch(BST_IMAGE, { headers: { 'User-Agent': 'ECHO-tutor-benchmark/0.1' } })
    if (!res.ok) return null
    return { mediaType: 'image/png', data: Buffer.from(await res.arrayBuffer()).toString('base64') }
  } catch {
    return null
  }
}

function candidateConfig(c: Candidate, cfg: VoiceConfig): VoiceConfig {
  return { ...cfg, strongModel: c.model, deepModel: c.model }
}

describe.skipIf(!live)('live: model benchmark for the quality-first route', () => {
  it('runs every candidate on the difficult questions and writes the report', { timeout: 4 * 60 * 60 * 1000 }, async () => {
    if (!base.ok) return
    const cfg = base.config
    const wanted = process.env.ECHO_BENCH_CANDIDATES?.split(',').map((s) => s.trim()).filter(Boolean)
    const candidates = wanted?.length ? CANDIDATES.filter((c) => wanted.includes(c.name)) : CANDIDATES
    const client = new Anthropic({
      apiKey: cfg.anthropicApiKey,
      maxRetries: 2,
      ...(cfg.anthropicWorkspaceId ? { defaultHeaders: { 'anthropic-workspace-id': cfg.anthropicWorkspaceId } } : {})
    })
    const image = await fetchImage()
    const runs: Run[] = []

    for (const c of candidates) {
      const chat = new ClaudeChat(candidateConfig(c, cfg), client, () => {})
      for (const q of QUESTIONS) {
        if (q.screen && !image) continue
        const system = q.lesson
          ? buildSystemPrompt(LESSON_PROMPT_ADDENDUM, skillsPrompt(selectSkills({ whiteboard: true, deep: true, practice: false })))
          : buildSystemPrompt()
        let text = ''
        let first: number | null = null
        const t0 = Date.now()
        const run: Run = { candidate: c.name, model: c.model, question: q.id, kind: q.kind, firstTextMs: null, totalMs: 0, words: 0, text: '' }
        try {
          await chat.stream({
            system,
            messages: q.turns,
            turnContext: q.screen ? buildTurnContext({ screen: SCREEN_NOTE }) : undefined,
            image: q.screen ? image! : undefined,
            tier: 'strong',
            deep: !!q.lesson,
            reasoning: c.reasoning,
            effort: c.effort,
            maxTokens: q.lesson ? 21000 : 3600,
            signal: new AbortController().signal,
            onText: (d) => {
              first ??= Date.now() - t0
              text += d
            }
          })
        } catch (err) {
          run.error = err instanceof Error ? err.message.slice(0, 200) : String(err)
        }
        run.totalMs = Date.now() - t0
        run.firstTextMs = first
        if (q.lesson) {
          const parser = new SegmentStreamParser()
          const segs = [...parser.push(text), ...parser.end()]
          run.lesson = {
            segments: segs.length,
            drawings: segs.filter((s) => s.drawing?.plan).length,
            drawErrors: segs.flatMap((s) => (s.drawing?.error ? [s.drawing.error] : []))
          }
          run.text = segs.map((s, i) => `[step ${i + 1}: ${s.objective}${s.drawing?.plan ? ` | draws: ${s.drawing.plan.setup.map((o) => o.op).join(', ') || 'cues only'}` : ''}] ${s.narration}`).join('\n')
        } else run.text = text.trim()
        run.words = run.text.split(/\s+/).filter(Boolean).length
        runs.push(run)
        console.log(`[bench] ${c.name} ${q.id}: first ${run.firstTextMs ?? '-'} ms, total ${run.totalMs} ms, ${run.words} words${run.error ? `, ERROR ${run.error}` : ''}`)
      }
    }

    // Blind judging: the judge never sees the candidate's name or model.
    for (const run of runs) {
      if (run.error || !run.text) continue
      const q = QUESTIONS.find((x) => x.id === run.question)!
      const convo = q.turns.map((m) => `${m.role === 'user' ? 'Learner' : 'ECHO (earlier)'}: ${m.content}`).join('\n')
      const extra = run.lesson ? `\nWhiteboard: ${run.lesson.segments} steps, ${run.lesson.drawings} valid drawings, drawing errors: ${run.lesson.drawErrors.join('; ') || 'none'}` : ''
      const content: Anthropic.ContentBlockParam[] = [
        ...(q.screen && image ? [{ type: 'image' as const, source: { type: 'base64' as const, media_type: image.mediaType, data: image.data } }] : []),
        { type: 'text', text: `${q.screen ? 'The image is what was on the learner\'s screen.\n\n' : ''}Conversation:\n${convo}\n\nReference notes:\n${q.reference}\n\nECHO's answer:\n${run.text}${extra}` }
      ]
      try {
        const msg = await client.messages
          .stream({ model: JUDGE_MODEL, max_tokens: 16000, output_config: { effort: 'high' }, system: JUDGE_SYSTEM, messages: [{ role: 'user', content }] })
          .finalMessage()
        const out = msg.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('')
        const json = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1)) as { score: number; correct: boolean; notes: string }
        run.judge = { score: Number(json.score), correct: !!json.correct, notes: String(json.notes ?? '') }
      } catch (err) {
        console.log(`[bench] judge failed for ${run.candidate} ${run.question}: ${err instanceof Error ? err.message.slice(0, 120) : err}`)
      }
    }

    const median = (xs: number[]): number | null => {
      const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b)
      return s.length ? s[Math.floor(s.length / 2)] : null
    }
    const lines = [
      `# ECHO model benchmark (${new Date().toISOString()})`,
      '',
      `Judge: ${JUDGE_MODEL} at high effort, blind. ${QUESTIONS.length} questions${image ? '' : ' (screen question skipped: image unavailable)'}.`,
      '',
      '| candidate | mean score | correct | median first word (ms) | median total (ms) | lesson first word (ms) | median words |',
      '|---|---|---|---|---|---|---|'
    ]
    for (const c of candidates) {
      const rs = runs.filter((r) => r.candidate === c.name)
      const judged = rs.filter((r) => r.judge)
      const mean = judged.length ? (judged.reduce((s, r) => s + r.judge!.score, 0) / judged.length).toFixed(2) : '-'
      const nonLesson = rs.filter((r) => r.kind !== 'lesson')
      lines.push(
        `| ${c.name} (${c.model}, ${c.reasoning}, ${c.effort}) | ${mean} | ${judged.filter((r) => r.judge!.correct).length}/${judged.length} | ${median(nonLesson.map((r) => r.firstTextMs ?? NaN)) ?? '-'} | ${median(nonLesson.map((r) => r.totalMs)) ?? '-'} | ${rs.find((r) => r.kind === 'lesson')?.firstTextMs ?? '-'} | ${median(nonLesson.map((r) => r.words)) ?? '-'} |`
      )
    }
    lines.push('', '## Per question', '', '| question | ' + candidates.map((c) => c.name).join(' | ') + ' |', '|---|' + candidates.map(() => '---').join('|') + '|')
    for (const q of QUESTIONS) {
      const cells = candidates.map((c) => {
        const r = runs.find((x) => x.candidate === c.name && x.question === q.id)
        if (!r) return 'skipped'
        if (r.error) return 'error'
        return `${r.judge ? r.judge.score : '?'}${r.judge && !r.judge.correct ? ' ✗' : ''} · ${r.firstTextMs ?? '-'} ms`
      })
      lines.push(`| ${q.id} | ${cells.join(' | ')} |`)
    }
    lines.push('', '## Judge notes', '')
    for (const r of runs) if (r.judge) lines.push(`- **${r.candidate} / ${r.question}** (${r.judge.score}): ${r.judge.notes}`)

    const dir = join(process.cwd(), 'tests', 'live', 'out')
    mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    writeFileSync(join(dir, `model-bench-${stamp}.md`), lines.join('\n') + '\n')
    writeFileSync(join(dir, `model-bench-${stamp}.json`), JSON.stringify({ judge: JUDGE_MODEL, candidates, runs }, null, 2))
    console.log('\n' + lines.slice(0, 6 + candidates.length).join('\n') + `\n\nFull report: tests/live/out/model-bench-${stamp}.md\n`)

    expect(runs.some((r) => !r.error)).toBe(true)
  })
})
