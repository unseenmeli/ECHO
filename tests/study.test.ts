import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildIndex, FULL_TEXT_CHARS, search, splitPage, studyContext, terms, type StudyDoc } from '../src/main/study/retrieve'
import { STUDY_MATERIAL_GUIDE, StudyMaterial } from '../src/main/study/studyMaterial'
import { voiceSession } from './helpers/voice-fakes'

/** A real (tiny) PDF with one text line per entry, one page per array, so pdf.js extraction is tested for real. */
function pdf(pages: string[][]): Buffer {
  const objs: string[] = []
  const add = (o: string): number => objs.push(o)
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  const contents = pages.map((lines) => {
    const stream = `BT /F1 12 Tf 72 720 Td ${lines.map((l) => `(${l}) Tj 0 -18 Td`).join(' ')} ET`
    return add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`)
  })
  const pagesId = objs.length + pages.length + 1
  const kids = contents.map((c) => add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Contents ${c} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`))
  add(`<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`)
  const catalog = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`)
  let out = '%PDF-1.4\n'
  const offsets = objs.map((o, i) => {
    const at = Buffer.byteLength(out)
    out += `${i + 1} 0 obj\n${o}\nendobj\n`
    return at
  })
  const xref = Buffer.byteLength(out)
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out)
}

const memoryIo = () => {
  const files = new Map<string, string>()
  return { files, io: { read: (f: string) => files.get(f) ?? null, write: (f: string, d: string) => void files.set(f, d) } }
}

const doc = (name: string, pages: string[], id = name): StudyDoc => ({ id, name, pages, unit: 'page' })
const filler = (topic: string, n: number): string => Array.from({ length: n }, (_, i) => `Paragraph ${i} keeps talking about ${topic} in general terms.`).join(' ')

describe('retrieval', () => {
  it('matches word forms and ignores filler words', () => {
    expect(terms('The reactions are happening in Membranes')).toEqual(['reaction', 'happen', 'membrane'])
    expect(terms('membrane processes process boxes analysis')).toEqual(['membrane', 'process', 'process', 'box', 'analysis'])
  })

  it('splits pages into passages without crossing sentence ends where it can', () => {
    const parts = splitPage(filler('cells', 60), 300)
    expect(parts.length).toBeGreaterThan(5)
    expect(parts.every((p) => p.length <= 300)).toBe(true)
    expect(parts.every((p) => /\.$/.test(p))).toBe(true)
  })

  it('ranks the passage that answers the question first, and never returns unrelated ones', () => {
    const docs = [doc('bio.pdf', [filler('photosynthesis', 20), 'The Calvin cycle fixes carbon dioxide into sugar in the stroma.', filler('mitochondria', 20)])]
    const index = buildIndex(docs)
    const hits = search(index, 'Where does the Calvin cycle happen?')
    expect(hits[0]).toMatchObject({ docName: 'bio.pdf', page: 2 })
    expect(search(index, 'Who won the 1998 world cup?')).toEqual([])
  })

  it('gives small material in full, with every page labelled', () => {
    const docs = [doc('notes.pdf', ['Osmosis moves water.', 'Diffusion moves solutes.'])]
    const ctx = studyContext(docs, buildIndex(docs), 'anything')!
    expect(ctx).toContain('[notes.pdf, page 1]\nOsmosis moves water.')
    expect(ctx).toContain('[notes.pdf, page 2]\nDiffusion moves solutes.')
  })

  it('gives large material as the matching passages only, in reading order', () => {
    const pages = Array.from({ length: 30 }, (_, i) => (i === 21 ? 'Enzymes lower the activation energy of a reaction.' : filler('general biology', 12)))
    const docs = [doc('textbook.pdf', pages)]
    const index = buildIndex(docs)
    expect(index.totalChars).toBeGreaterThan(FULL_TEXT_CHARS)
    const ctx = studyContext(docs, index, 'How do enzymes affect activation energy?')!
    expect(ctx).toContain('[textbook.pdf, page 22]\nEnzymes lower the activation energy')
    expect(ctx.length).toBeLessThan(6000)
    expect(studyContext(docs, index, 'Explain quantum tunnelling')).toMatch(/No passage in it matches this question/)
  })
})

describe('study material', () => {
  const dir = mkdtempSync(join(tmpdir(), 'echo-study-'))
  const biology = join(dir, 'biology.pdf')
  writeFileSync(biology, pdf([['Chapter 1: Photosynthesis', 'Plants convert light energy into chemical energy.'], ['Chapter 2: The Calvin cycle', 'The Calvin cycle fixes carbon dioxide into sugar.']]))

  it('reads a real PDF page by page and answers with page labels', async () => {
    const { io } = memoryIo()
    const study = new StudyMaterial('study.json', io, undefined, () => {})
    const r = await study.add(biology)
    expect(r).toMatchObject({ ok: true, file: { name: 'biology.pdf', pages: 2, unit: 'page' } })
    expect(study.contextFor('What does the Calvin cycle do?')).toContain('[biology.pdf, page 2]\nChapter 2: The Calvin cycle')
  })

  it('remembers the files across restarts and drops ones that disappeared', async () => {
    const { io, files } = memoryIo()
    const notes = join(dir, 'notes.md')
    writeFileSync(notes, '# Cells\n\nCells are the basic unit of life.')
    const first = new StudyMaterial('study.json', io, undefined, () => {})
    await first.add(biology)
    await first.add(notes)
    expect(JSON.parse(files.get('study.json')!).files).toEqual([biology, notes])

    files.set('study.json', JSON.stringify({ files: [biology, join(dir, 'gone.pdf'), notes] }))
    const next = new StudyMaterial('study.json', io, undefined, () => {})
    await next.load()
    expect(next.list().map((f) => [f.name, f.unit])).toEqual([['biology.pdf', 'page'], ['notes.md', 'part']])
    expect(JSON.parse(files.get('study.json')!).files).toEqual([biology, notes])
  })

  it('flags a PDF with no selectable text instead of silently using nothing', async () => {
    const study = new StudyMaterial('s.json', memoryIo().io, async () => ({ pages: ['', ' '], unit: 'page' }), () => {})
    const r = await study.add('/scans/lecture.pdf')
    expect(r).toMatchObject({ ok: true, file: { problem: 'no selectable text (a scanned PDF?)' } })
    expect(study.hasMaterial()).toBe(false)
    expect(study.contextFor('anything')).toBeNull()
  })

  it('refuses files it cannot read, saying why', async () => {
    const study = new StudyMaterial('s.json', memoryIo().io, undefined, () => {})
    expect(await study.add(join(dir, 'missing.pdf'))).toMatchObject({ ok: false, message: expect.stringMatching(/^Couldn't read missing.pdf/) })
    writeFileSync(join(dir, 'slides.pptx'), 'x')
    expect(await study.add(join(dir, 'slides.pptx'))).toMatchObject({ ok: false, message: expect.stringMatching(/only PDF, text and Markdown/) })
  })

  it('the session gives the tutor the guide and this turn\'s passages, outside the cached history', async () => {
    const study = new StudyMaterial('s.json', memoryIo().io, undefined, () => {})
    await study.add(biology)
    const { chat, stt } = voiceSession({ study })
    stt.turn('StartOfTurn', 'What', 0)
    stt.turn('EndOfTurn', 'What does the Calvin cycle do?', 0)
    await new Promise((r) => setTimeout(r, 0))
    const req = chat.calls.at(-1)!
    expect(req.system).toContain(STUDY_MATERIAL_GUIDE)
    expect(req.turnContext).toContain('<study_material>')
    expect(req.turnContext).toContain('[biology.pdf, page 2]')
    expect(req.messages.at(-1)).toEqual({ role: 'user', content: 'What does the Calvin cycle do?' })
  })

  it('adds nothing to the request when no material was added', async () => {
    const { chat, stt } = voiceSession({ study: new StudyMaterial('s.json', memoryIo().io, undefined, () => {}) })
    stt.turn('StartOfTurn', 'What', 0)
    stt.turn('EndOfTurn', 'What is a cell?', 0)
    await new Promise((r) => setTimeout(r, 0))
    expect(chat.calls.at(-1)!.system).not.toContain('STUDY MATERIAL')
    expect(chat.calls.at(-1)!.turnContext ?? '').not.toContain('study_material')
  })
})
