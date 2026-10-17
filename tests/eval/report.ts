import type { EvalRun, QuestionResult, TurnResult } from './harness'

// A self-contained HTML page for comparing variants by ear: per question, the replies of every variant side by
// side with their audio, timings and automatic checks, and a 1-5 rating per reply. Blind mode hides the variant names
// and shuffles the columns per question. Ratings stay in the browser (localStorage) and export as JSON.

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

const median = (xs: number[]): number | null => {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b)
  return v.length ? v[Math.floor(v.length / 2)] : null
}

function summaryRows(run: EvalRun): string {
  return run.variants
    .map((v) => {
      const rs = run.results.filter((r) => r.variant === v.name)
      const last = rs.map((r) => r.turns.at(-1)).filter((t): t is TurnResult => !!t)
      const checks = rs.flatMap((r) => r.checks)
      const ms = (xs: Array<number | null>): string => {
        const m = median(xs.filter((x): x is number => x !== null))
        return m === null ? '–' : `${Math.round(m)} ms`
      }
      const avg = (xs: number[]): string => (xs.length ? (xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1) : '–')
      return `<tr><th scope="row">${esc(v.name)}<div class="muted">${esc(v.description)}</div></th>
        <td>${checks.filter((c) => c.ok).length}/${checks.length}</td>
        <td>${ms(last.map((t) => t.firstAudioMs))}</td>
        <td>${ms(last.map((t) => t.firstTextMs))}</td>
        <td>${avg(last.map((t) => t.words))}</td>
        <td>${avg(last.map((t) => t.flushes))}</td>
        <td class="avg-rating" data-variant="${esc(v.name)}">–</td></tr>`
    })
    .join('\n')
}

function turnBlock(t: TurnResult, i: number, many: boolean): string {
  const meta = [
    t.tier && `${t.tier}${t.model ? ` · ${t.model}` : ''}`,
    t.firstAudioMs !== null && `first audio ${t.firstAudioMs} ms`,
    `${t.words} words`,
    `${t.flushes} piece${t.flushes === 1 ? '' : 's'}`,
    t.audioSeconds && `${t.audioSeconds}s audio`,
    t.searches && `${t.searches} search${t.searches === 1 ? '' : 'es'}`,
    t.fetches && `${t.fetches} page${t.fetches === 1 ? '' : 's'} read`
  ].filter(Boolean)
  const sources = t.sources.filter((s) => s.cited)
  return `<div class="turn">
    ${many ? `<div class="turn-label">Turn ${i + 1}</div>` : ''}
    ${t.audioFile ? `<audio controls preload="none" src="${esc(t.audioFile)}"></audio>` : '<div class="muted">No audio</div>'}
    <details><summary>Transcript</summary><p>${esc(t.spoken || '(nothing)')}</p></details>
    <div class="meta">${meta.map((m) => `<span>${esc(String(m))}</span>`).join('')}</div>
    ${sources.length ? `<div class="sources">${sources.map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noreferrer">${esc(s.title)}</a>`).join(' · ')}</div>` : ''}
    ${t.error ? `<div class="bad">${esc(t.error)}</div>` : ''}
  </div>`
}

function column(r: QuestionResult): string {
  const failed = r.checks.filter((c) => !c.ok).length
  return `<div class="col" data-variant="${esc(r.variant)}">
    <div class="col-head"><span class="vname">${esc(r.variant)}</span><span class="blind-label"></span>
      <span class="badge ${failed ? 'bad' : 'good'}">${r.checks.length - failed}/${r.checks.length}</span></div>
    ${r.turns.map((t, i) => turnBlock(t, i, r.turns.length > 1)).join('')}
    <ul class="checks">${r.checks.map((c) => `<li class="${c.ok ? 'good' : 'bad'}">${c.ok ? '✓' : '✗'} ${esc(c.name)}${c.detail ? ` <span class="muted">(${esc(c.detail)})</span>` : ''}</li>`).join('')}</ul>
    <div class="rate" role="radiogroup" aria-label="Rating">${[1, 2, 3, 4, 5].map((n) => `<button type="button" data-score="${n}" aria-pressed="false">${n}</button>`).join('')}</div>
    <textarea placeholder="Notes: rhythm, pauses, accuracy…" rows="2"></textarea>
  </div>`
}

export function renderReport(run: EvalRun): string {
  const cards = run.questions
    .map((q) => {
      const rs = run.results.filter((r) => r.id === q.id)
      const first = rs[0]
      const asked = q.turns
        .map((t, i) => {
          const heard = first?.turns[i]
          const tx = heard?.transcribed ? ` <span class="muted">(heard: “${esc(heard.transcribed.text)}”, WER ${Math.round(heard.transcribed.wer * 100)}%)</span>` : ''
          const unsure = t.unsure?.length ? ` <span class="muted">(unsure: ${t.unsure.map(([w, c]) => `${esc(w)} ${c}`).join(', ')})</span>` : ''
          return `<li>“${esc(t.say)}”${tx}${unsure}</li>`
        })
        .join('')
      return `<section class="q" data-q="${esc(q.id)}">
        <h2><span class="cat">${esc(q.category)}</span> ${esc(q.id)}</h2>
        <ol class="asked">${asked}</ol>
        ${q.study?.length ? `<div class="muted">Study material: ${q.study.map(esc).join(', ')}</div>` : ''}
        <div class="cols">${rs.map(column).join('')}</div>
      </section>`
    })
    .join('\n')

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>ECHO Quality Eval</title>
<style>
:root { --bg:#f6f5f2; --card:#fff; --ink:#1c1c1e; --muted:#6b6963; --line:#e4e1da; --good:#1f8a4c; --bad:#c62f3b; --accent:#ff2e9a; }
@media (prefers-color-scheme: dark) { :root { --bg:#161618; --card:#212124; --ink:#f2f1ee; --muted:#a19f99; --line:#34343a; --good:#4cc787; --bad:#ff6b76; } }
* { box-sizing: border-box; }
body { margin:0; padding:24px 16px 64px; background:var(--bg); color:var(--ink); font:15px/1.45 -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; }
main { max-width:1400px; margin:0 auto; }
h1 { font-size:22px; margin:0 0 4px; } h2 { font-size:16px; margin:0 0 8px; }
.muted { color:var(--muted); font-size:13px; }
table { border-collapse:collapse; width:100%; background:var(--card); border-radius:12px; overflow:hidden; margin:16px 0; }
th, td { text-align:left; padding:8px 12px; border-bottom:1px solid var(--line); vertical-align:top; }
thead th { font-size:12px; text-transform:uppercase; letter-spacing:.04em; color:var(--muted); }
.toolbar { display:flex; gap:12px; align-items:center; flex-wrap:wrap; margin:12px 0 20px; }
button { font:inherit; border:1px solid var(--line); background:var(--card); color:var(--ink); border-radius:8px; padding:4px 10px; cursor:pointer; }
.q { background:var(--card); border-radius:14px; padding:16px; margin:16px 0; border:1px solid var(--line); }
.cat { font-size:11px; text-transform:uppercase; letter-spacing:.05em; background:var(--accent); color:#fff; border-radius:6px; padding:2px 6px; margin-right:6px; vertical-align:2px; }
.asked { margin:0 0 12px; padding-left:20px; }
.cols { display:grid; grid-template-columns:repeat(auto-fit, minmax(280px, 1fr)); gap:12px; }
.col { border:1px solid var(--line); border-radius:10px; padding:12px; min-width:0; }
.col-head { display:flex; gap:8px; align-items:center; margin-bottom:8px; font-weight:600; }
.badge { margin-left:auto; font-size:12px; border-radius:6px; padding:1px 6px; color:#fff; }
.badge.good { background:var(--good); } .badge.bad { background:var(--bad); }
audio { width:100%; height:36px; }
.turn { margin-bottom:10px; } .turn-label { font-size:12px; color:var(--muted); }
details p { margin:6px 0; white-space:pre-wrap; overflow-wrap:anywhere; }
.meta { display:flex; flex-wrap:wrap; gap:6px; font-size:12px; color:var(--muted); }
.meta span { border:1px solid var(--line); border-radius:6px; padding:0 6px; }
.sources { font-size:12px; margin-top:4px; overflow-wrap:anywhere; } .sources a { color:inherit; }
.checks { list-style:none; padding:0; margin:8px 0; font-size:13px; }
.good { color:var(--good); } .bad { color:var(--bad); } .badge.good, .badge.bad { color:#fff; }
.rate { display:flex; gap:4px; margin:6px 0; }
.rate button[aria-pressed="true"] { background:var(--accent); color:#fff; border-color:var(--accent); }
textarea { width:100%; font:inherit; font-size:13px; background:transparent; color:inherit; border:1px solid var(--line); border-radius:8px; padding:6px; }
body.blind .vname { display:none; } body:not(.blind) .blind-label { display:none; }
</style></head>
<body><main>
<h1>ECHO Quality Eval</h1>
<div class="muted">Run ${esc(run.startedAt)} · ${run.questions.length} questions × ${run.variants.length} variants</div>
<table><thead><tr><th>Variant</th><th>Checks</th><th>First audio (median)</th><th>First text (median)</th><th>Words (avg)</th><th>Pieces (avg)</th><th>Your rating (avg)</th></tr></thead>
<tbody>${summaryRows(run)}</tbody></table>
<div class="toolbar">
  <label><input type="checkbox" id="blind"> Blind listening (hide and shuffle variants)</label>
  <button type="button" id="export">Export ratings</button>
  <span class="muted">Ratings are saved in this browser.</span>
</div>
${cards}
</main>
<script>
const KEY = 'echo-eval:${esc(run.startedAt)}';
let ratings = {};
try { ratings = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch {}
const save = () => { try { localStorage.setItem(KEY, JSON.stringify(ratings)); } catch {} };
const id = (q, v) => q + '::' + v;
function refresh() {
  document.querySelectorAll('.avg-rating').forEach((td) => {
    const s = Object.entries(ratings).filter(([k, r]) => k.endsWith('::' + td.dataset.variant) && r.score).map(([, r]) => r.score);
    td.textContent = s.length ? (s.reduce((a, b) => a + b, 0) / s.length).toFixed(2) + ' (' + s.length + ')' : '–';
  });
}
document.querySelectorAll('.q').forEach((sec) => {
  const q = sec.dataset.q;
  sec.querySelectorAll('.col').forEach((col) => {
    const k = id(q, col.dataset.variant);
    const r = ratings[k] || {};
    const buttons = col.querySelectorAll('.rate button');
    const paint = () => buttons.forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.score) === (ratings[k] || {}).score)));
    buttons.forEach((b) => b.addEventListener('click', () => { ratings[k] = { ...(ratings[k] || {}), score: Number(b.dataset.score) }; save(); paint(); refresh(); }));
    const ta = col.querySelector('textarea');
    ta.value = r.note || '';
    ta.addEventListener('input', () => { ratings[k] = { ...(ratings[k] || {}), note: ta.value }; save(); });
    paint();
  });
});
// Blind mode: a fixed shuffle per question (seeded by its id), labelled A, B, C...
function shuffleKey(s) { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; }
document.getElementById('blind').addEventListener('change', (e) => {
  const on = e.target.checked;
  document.body.classList.toggle('blind', on);
  document.querySelectorAll('.q').forEach((sec) => {
    const wrap = sec.querySelector('.cols');
    const cols = [...wrap.children];
    const order = on ? cols.slice().sort((a, b) => shuffleKey(sec.dataset.q + a.dataset.variant) - shuffleKey(sec.dataset.q + b.dataset.variant)) : cols.slice().sort((a, b) => Number(a.dataset.i) - Number(b.dataset.i));
    order.forEach((c, i) => { wrap.appendChild(c); c.querySelector('.blind-label').textContent = String.fromCharCode(65 + i); });
  });
});
document.querySelectorAll('.cols').forEach((w) => [...w.children].forEach((c, i) => (c.dataset.i = i)));
document.getElementById('export').addEventListener('click', () => {
  const blob = new Blob([JSON.stringify({ run: '${esc(run.startedAt)}', ratings }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'echo-eval-ratings.json';
  a.click();
});
refresh();
</script>
</body></html>`
}
