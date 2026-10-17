// Finds the passages of the learner's study material that matter for a question: page-sized text is split into
// passages that never cross a page (so a passage can always say where it came from), and ranked with BM25. Pure
// functions, no I/O, so they are easy to test.

export interface StudyDoc {
  id: string
  name: string
  /** Text per page (PDF) or per part (plain text). */
  pages: string[]
  /** 'page' for PDFs, 'part' for text files that have no pages. */
  unit: 'page' | 'part'
}

export interface Passage {
  docId: string
  docName: string
  unit: 'page' | 'part'
  /** 1-based page or part number. */
  page: number
  text: string
}

const PASSAGE_CHARS = 900
/** Material up to this size is given in full: nothing can be missed, and it costs little. */
export const FULL_TEXT_CHARS = 12_000

const STOPWORDS = new Set(
  'a an and are as at be been but by can could did do does doing for from had has have how i if in into is it its just me my of on or our so than that the their them then there these they this those to was we were what when where which while who why will with would you your about also any each more most other some such only own same very s t don should now'.split(' ')
)

/** Lowercase word stems without stopwords ("Reactions" and "reaction" match). */
export function terms(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((w) => !STOPWORDS.has(w) && (w.length > 1 || /\d/.test(w)))
    .map(stem)
}

/** Just enough stemming that plurals and -ing/-ed forms meet ("membranes"/"membrane", "processes"/"process"). */
function stem(w: string): string {
  if (w.length <= 4) return w
  if (w.endsWith('ies')) return w.slice(0, -3) + 'y'
  if (/(?:s|x|z|ch|sh)es$/.test(w)) return w.slice(0, -2)
  if (w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') && !w.endsWith('is')) return w.slice(0, -1)
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3)
  if (w.length > 5 && w.endsWith('ed')) return w.slice(0, -2)
  return w
}

/** Splits a page into passages of about PASSAGE_CHARS, at sentence ends where possible. */
export function splitPage(text: string, max = PASSAGE_CHARS): string[] {
  const clean = text.replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim()
  if (!clean) return []
  const sentences = clean.match(/[^.!?\n]+(?:[.!?]+|\n|$)/g) ?? [clean]
  const out: string[] = []
  let cur = ''
  for (const raw of sentences) {
    const s = raw.trim()
    if (!s) continue
    if (cur && cur.length + s.length + 1 > max) {
      out.push(cur)
      cur = ''
    }
    // A single sentence longer than a passage (a table row dump, say) is cut at a word boundary.
    let rest = s
    while (rest.length > max) {
      const cut = rest.lastIndexOf(' ', max)
      out.push(rest.slice(0, cut > 0 ? cut : max))
      rest = rest.slice(cut > 0 ? cut + 1 : max)
    }
    cur = cur ? `${cur} ${rest}` : rest
  }
  if (cur) out.push(cur)
  return out
}

export interface StudyIndex {
  passages: Passage[]
  termCounts: Array<Map<string, number>>
  lengths: number[]
  docFreq: Map<string, number>
  avgLength: number
  totalChars: number
}

export function buildIndex(docs: StudyDoc[]): StudyIndex {
  const passages: Passage[] = []
  for (const d of docs) {
    d.pages.forEach((text, i) => {
      for (const p of splitPage(text)) passages.push({ docId: d.id, docName: d.name, unit: d.unit, page: i + 1, text: p })
    })
  }
  const termCounts = passages.map((p) => {
    const m = new Map<string, number>()
    for (const t of terms(p.text)) m.set(t, (m.get(t) ?? 0) + 1)
    return m
  })
  const lengths = termCounts.map((m) => [...m.values()].reduce((a, b) => a + b, 0))
  const docFreq = new Map<string, number>()
  for (const m of termCounts) for (const t of m.keys()) docFreq.set(t, (docFreq.get(t) ?? 0) + 1)
  return {
    passages,
    termCounts,
    lengths,
    docFreq,
    avgLength: lengths.length ? lengths.reduce((a, b) => a + b, 0) / lengths.length : 0,
    totalChars: docs.reduce((n, d) => n + d.pages.reduce((m, p) => m + p.length, 0), 0)
  }
}

/** The k best passages for the query (BM25), best first. Passages that share no term with it are never returned. */
export function search(index: StudyIndex, query: string, k = 5): Array<Passage & { score: number }> {
  const q = [...new Set(terms(query))]
  if (!q.length || !index.passages.length) return []
  const N = index.passages.length
  const k1 = 1.2
  const b = 0.75
  const scored = index.passages.map((p, i) => {
    let score = 0
    const tf = index.termCounts[i]
    for (const t of q) {
      const f = tf.get(t)
      if (!f) continue
      const df = index.docFreq.get(t) ?? 0
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5))
      score += (idf * f * (k1 + 1)) / (f + k1 * (1 - b + (b * index.lengths[i]) / (index.avgLength || 1)))
    }
    return { ...p, score }
  })
  return scored
    .filter((p) => p.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
}

const where = (p: Pick<Passage, 'docName' | 'unit' | 'page'>): string => `${p.docName}, ${p.unit} ${p.page}`

/**
 * What the model is told for one turn: small material in full, otherwise the passages that match the question (in
 * reading order), or just what files exist when nothing matches.
 */
export function studyContext(docs: StudyDoc[], index: StudyIndex, query: string, k = 5): string | null {
  if (!docs.length) return null
  const files = docs.map((d) => `${d.name} (${d.pages.length} ${d.unit}${d.pages.length === 1 ? '' : 's'})`).join(', ')
  const header = `The learner added their own study material: ${files}.`
  if (index.totalChars <= FULL_TEXT_CHARS) {
    const body = docs
      .flatMap((d) => d.pages.map((text, i) => (text.trim() ? `[${where({ docName: d.name, unit: d.unit, page: i + 1 })}]\n${text.trim()}` : '')))
      .filter(Boolean)
      .join('\n\n')
    return `<study_material>\n${header} Here it is in full.\n\n${body}\n</study_material>`
  }
  const hits = search(index, query, k)
  if (!hits.length) return `<study_material>\n${header} No passage in it matches this question.\n</study_material>`
  const ordered = [...hits].sort((a, b) => (a.docName === b.docName ? a.page - b.page : a.docName.localeCompare(b.docName)))
  const body = ordered.map((p) => `[${where(p)}]\n${p.text}`).join('\n\n')
  return `<study_material>\n${header} The passages most related to this question:\n\n${body}\n</study_material>`
}
