import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import PptxGenJS from 'pptxgenjs'
import { deckFileName, THEMES, type Deck, type SlidePicture } from '../../shared/deck'
import type { DeckFormat } from './deckTools'

// Saving a deck without asking anything: it goes to Documents/Echo Presentations under its title (with " 2", " 3"…
// when that name is taken). PDFs are printed from the deck window, so they look exactly like it; PowerPoint files
// are built here with editable text boxes and the speaker notes.

export const SAVE_FOLDER = 'Echo Presentations'

/** A file path in `dir` for this title that doesn't overwrite anything. */
export function freePath(dir: string, title: string, ext: string, exists: (p: string) => boolean = existsSync): string {
  const base = deckFileName(title)
  for (let n = 1; ; n++) {
    const path = join(dir, `${base}${n === 1 ? '' : ` ${n}`}.${ext}`)
    if (!exists(path)) return path
  }
}

/** Writes the deck to `documentsDir`/Echo Presentations and returns the file's path. */
export async function saveDeck(deck: Deck, format: DeckFormat, documentsDir: string, printPdf: () => Promise<Buffer>): Promise<string> {
  const dir = join(documentsDir, SAVE_FOLDER)
  await mkdir(dir, { recursive: true })
  const data = format === 'pdf' ? await printPdf() : await buildPptx(deck)
  const path = freePath(dir, deck.title, format)
  await writeFile(path, data)
  return path
}

// --- PowerPoint ---------------------------------------------------------------------------------------------

/** 16:9 widescreen, in inches. */
const W = 13.333
const H = 7.5
const M = 0.7
const FONT = 'Helvetica Neue'

const hex = (c: string): string => c.replace('#', '')

/** The largest box with the picture's proportions that fits in (x, y, w, h), centred. */
function fit(p: SlidePicture, x: number, y: number, w: number, h: number): { x: number; y: number; w: number; h: number } {
  const scale = Math.min(w / p.width, h / p.height)
  const fw = p.width * scale
  const fh = p.height * scale
  return { x: x + (w - fw) / 2, y: y + (h - fh) / 2, w: fw, h: fh }
}

export async function buildPptx(deck: Deck): Promise<Buffer> {
  const pptx = new PptxGenJS()
  pptx.layout = 'LAYOUT_WIDE'
  pptx.title = deck.title
  const t = THEMES[deck.theme]
  const text = hex(t.text)
  const muted = hex(t.muted)
  const accent = hex(t.accent)
  const surface = hex(t.surface)

  for (const s of deck.slides) {
    const slide = pptx.addSlide()
    slide.background = { color: hex(t.background) }
    const picture = s.picture ?? null
    const heading = (y = 0.45, size = 32): void => {
      slide.addText(s.title, { x: M, y, w: W - 2 * M, h: 1.1, fontFace: FONT, fontSize: size, bold: true, color: text, valign: 'top', fit: 'shrink' })
    }
    const bullets = (items: string[], x: number, y: number, w: number, h: number, size = 22): void => {
      slide.addText(
        items.map((b) => ({ text: b, options: { bullet: { indent: 24 }, paraSpaceAfter: 10 } })),
        { x, y, w, h, fontFace: FONT, fontSize: size, color: text, valign: 'top', fit: 'shrink' }
      )
    }
    const image = (x: number, y: number, w: number, h: number): void => {
      if (!picture) return
      slide.addImage({ data: picture.dataURL, ...fit(picture, x, y, w, h) })
      slide.addText(picture.credit, { x: W - 6.2, y: H - 0.4, w: 6, h: 0.3, fontFace: FONT, fontSize: 8, color: muted, align: 'right' })
    }
    switch (s.layout) {
      case 'title':
      case 'section': {
        const tw = picture ? 6.3 : W - 2 * M
        if (s.layout === 'section') slide.addShape(pptx.ShapeType.rect, { x: M, y: 2.55, w: 1.2, h: 0.1, fill: { color: accent } })
        slide.addText(s.title, { x: M, y: 2.8, w: tw, h: 1.6, fontFace: FONT, fontSize: s.layout === 'title' ? 44 : 38, bold: true, color: text, valign: 'bottom', fit: 'shrink' })
        if (s.subtitle) slide.addText(s.subtitle, { x: M, y: 4.5, w: tw, h: 1, fontFace: FONT, fontSize: 20, color: muted, valign: 'top', fit: 'shrink' })
        image(7.4, 0.8, W - 7.4 - M, H - 1.6)
        break
      }
      case 'image':
        heading()
        if (s.bullets?.length) bullets(s.bullets, M, 1.8, 5.4, 4.9, 20)
        image(s.bullets?.length ? 6.5 : M, 1.7, s.bullets?.length ? W - 6.5 - M : W - 2 * M, 5.1)
        break
      case 'quote':
        slide.addText(`“${s.quote!.text}”`, { x: 1.4, y: 1.6, w: W - 2.8, h: 3.4, fontFace: FONT, fontSize: 32, italic: true, color: text, align: 'center', valign: 'middle', fit: 'shrink' })
        if (s.quote!.by) slide.addText(`— ${s.quote!.by}`, { x: 1.4, y: 5.1, w: W - 2.8, h: 0.6, fontFace: FONT, fontSize: 18, color: accent, align: 'center' })
        if (s.title) slide.addText(s.title, { x: M, y: 0.5, w: W - 2 * M, h: 0.6, fontFace: FONT, fontSize: 16, color: muted })
        break
      case 'stats': {
        heading()
        const stats = s.stats!
        const gap = 0.4
        const bw = (W - 2 * M - gap * (stats.length - 1)) / stats.length
        stats.forEach((st, i) => {
          const x = M + i * (bw + gap)
          slide.addShape(pptx.ShapeType.roundRect, { x, y: 2.3, w: bw, h: 3.6, fill: { color: surface }, rectRadius: 0.15 })
          slide.addText(st.value, { x, y: 2.6, w: bw, h: 1.6, fontFace: FONT, fontSize: 54, bold: true, color: accent, align: 'center', fit: 'shrink' })
          slide.addText(st.label, { x: x + 0.2, y: 4.2, w: bw - 0.4, h: 1.4, fontFace: FONT, fontSize: 16, color: text, align: 'center', valign: 'top', fit: 'shrink' })
        })
        break
      }
      case 'compare': {
        heading()
        const cw = (W - 2 * M - 0.4) / 2
        const columns: Array<[string | undefined, string[]]> = [
          [s.leftTitle, s.bullets!],
          [s.rightTitle, s.right!]
        ]
        columns.forEach(([title, items], i) => {
          const x = M + i * (cw + 0.4)
          slide.addShape(pptx.ShapeType.roundRect, { x, y: 1.8, w: cw, h: 5, fill: { color: surface }, rectRadius: 0.12 })
          if (title) slide.addText(title, { x: x + 0.3, y: 2, w: cw - 0.6, h: 0.6, fontFace: FONT, fontSize: 20, bold: true, color: accent })
          bullets(items, x + 0.3, title ? 2.7 : 2.1, cw - 0.6, 3.9, 18)
        })
        break
      }
      case 'closing':
        slide.addText(s.title, { x: M, y: s.bullets?.length ? 1.2 : 2.6, w: W - 2 * M, h: 1.5, fontFace: FONT, fontSize: 42, bold: true, color: text, align: 'center', valign: 'middle', fit: 'shrink' })
        if (s.subtitle) slide.addText(s.subtitle, { x: M, y: s.bullets?.length ? 2.7 : 4.1, w: W - 2 * M, h: 0.8, fontFace: FONT, fontSize: 20, color: muted, align: 'center' })
        if (s.bullets?.length) bullets(s.bullets, 3, 3.7, W - 6, 3, 20)
        break
      default:
        heading()
        bullets(s.bullets ?? [], M, 1.8, W - 2 * M, 5.1)
    }
    if (s.notes) slide.addNotes(s.notes)
  }
  const out = await pptx.write({ outputType: 'nodebuffer' })
  return Buffer.from(out as Uint8Array)
}
