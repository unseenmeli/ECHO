# Quality evaluation

A fixed set of questions run through ECHO's real pipeline (session, prompts, model routing, Claude, speech chunking,
Deepgram TTS), once per configuration variant, so you can tell which changes actually make ECHO better: by automatic
checks, by timings, and by listening.

```sh
npm run eval                                              # baseline vs small-pieces, all questions
ECHO_EVAL_VARIANTS=baseline,voice-helena,voice-apollo npm run eval
ECHO_EVAL_QUESTIONS=misheard-cache,tcp-udp npm run eval   # just these questions
```

It uses the keys in `.env` and **costs money**: each question is one short conversation per variant (14 questions ×
2 variants ≈ 30 Claude replies plus their speech). Results land in `tests/eval/out/<time>/`:

- `report.html`: open it in a browser. Per question, every variant's reply side by side with its audio, timings and
  checks. Tick **Blind listening** to hide the variant names and shuffle the columns, then rate each reply 1 to 5
  (saved in the browser; **Export ratings** downloads them as JSON). The summary table averages your ratings.
- `results.json`: everything, for comparing runs.
- `audio/<variant>/<question>.wav`: what ECHO said.

## Files

- `questions.json`: the question set. Each has `turns` (what the learner says; `unsure` simulates words speech
  recognition was unsure of), optional `study` files, and `expect` checks: `tier` (`fast`/`strong` model),
  `mentions` (regular expressions the reply must match), `asksBack`, `maxWords`, `cites`.
- `variants.json`: named sets of `ECHO_*` overrides (chunk sizes, voice, routing, page reading). Any setting from
  `.env.example` can be a variant.
- `material/`: study files used by the study-material questions.
- `recordings/`: optional. Record a question as `recordings/<question id>.wav` (or `<id>-<turn>.wav` for multi-turn
  questions; 16 kHz mono WAV) and the eval transcribes it with Deepgram instead of using the text, and reports the word
  error rate. That tests speech recognition and the misheard-word handling on real audio.

Keep the question set fixed while comparing changes; add questions when you find a new failure, and keep the old
`out/` folders to compare against.
