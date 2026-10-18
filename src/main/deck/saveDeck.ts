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

/**
 * Writes the deck to `documentsDir`/Echo Presentations and returns the file's path.
 * @param markPath The app icon, for the ECHO mark in each PowerPoint slide's footer.
 */
export async function saveDeck(deck: Deck, format: DeckFormat, documentsDir: string, printPdf: () => Promise<Buffer>, markPath?: string): Promise<string> {
  const dir = join(documentsDir, SAVE_FOLDER)
  await mkdir(dir, { recursive: true })
  const data = format === 'pdf' ? await printPdf() : await buildPptx(deck, markPath)
  const path = freePath(dir, deck.title, format)
  await writeFile(path, data)
  return path
}

// --- PowerPoint ---------------------------------------------------------------------------------------------
// The same ECHO look as the deck window, in editable shapes: headings and pictures trailed by pink afterimages,
// pink square bullets, rounded cards, and the ECHO mark with the page number in every footer. (PowerPoint has no
// pixel font, so small labels use a monospace face in capitals.)

/** 16:9 widescreen, in inches. */
const W = 13.333
const H = 7.5
const M = 0.75
const FONT = 'Helvetica Neue'
const LABEL_FONT = 'Courier New'
/** How far the two pink afterimages trail, and how see-through each is (0 opaque … 100 invisible). */
const ECHOES = [
  { dx: -0.1, transparency: 70 },
  { dx: -0.05, transparency: 15 }
]

const hex = (c: string): string => c.replace('#', '')
const pad = (n: number): string => String(n).padStart(2, '0')

/** The largest box with the picture's proportions that fits in (x, y, w, h), centred. */
function fit(p: SlidePicture, x: number, y: number, w: number, h: number): { x: number; y: number; w: number; h: number } {
  const scale = Math.min(w / p.width, h / p.height)
  const fw = p.width * scale
  const fh = p.height * scale
  return { x: x + (w - fw) / 2, y: y + (h - fh) / 2, w: fw, h: fh }
}

export async function buildPptx(deck: Deck, markPath?: string): Promise<Buffer> {
  const pptx = new PptxGenJS()
  pptx.layout = 'LAYOUT_WIDE'
  pptx.title = deck.title
  pptx.author = 'ECHO'
  const t = THEMES[deck.theme]
  const text = hex(t.text)
  const muted = hex(t.muted)
  const accent = hex(t.accent)
  const accentText = hex(t.accentText)
  const surface = hex(t.surface)
  let part = 0

  deck.slides.forEach((s, index) => {
    const slide = pptx.addSlide()
    slide.background = { color: hex(t.background) }
    const picture = s.picture ?? null
    type TextOptions = PptxGenJS.TextPropsOptions & { x: number; y: number; w: number; h: number }

    /** Text with ECHO's two pink copies trailing to the left. */
    const echoed = (value: string, o: TextOptions): void => {
      for (const e of ECHOES) slide.addText(value, { ...o, x: o.x + e.dx, color: accent, transparency: e.transparency })
      slide.addText(value, o)
    }
    const label = (value: string, o: TextOptions): void => {
      slide.addText(value.toUpperCase(), { fontFace: LABEL_FONT, fontSize: 14, bold: true, color: accentText, charSpacing: 2, ...o })
    }
    const heading = (): void => {
      slide.addText(s.title, { x: M, y: 0.55, w: W - 2 * M, h: 1.1, fontFace: FONT, fontSize: 34, bold: true, color: text, valign: 'top', fit: 'shrink' })
    }
    const bullets = (items: string[], x: number, y: number, w: number, h: number, size = 22): void => {
      slide.addText(
        items.map((b) => ({ text: b, options: { bullet: { characterCode: '25A0', indent: 26 }, paraSpaceAfter: 12 } })),
        { x, y, w, h, fontFace: FONT, fontSize: size, color: text, valign: 'top', fit: 'shrink' }
      )
    }
    const card = (x: number, y: number, w: number, h: number): void => {
      slide.addShape(pptx.ShapeType.roundRect, { x, y, w, h, fill: { color: surface }, rectRadius: 0.18, shadow: { type: 'outer', blur: 12, offset: 3, angle: 90, color: '000000', opacity: 0.12 } })
    }
    /** The picture, trailed by pink afterimages like the app icon. */
    const image = (x: number, y: number, w: number, h: number): void => {
      if (!picture) return
      const box = fit(picture, x + 0.24, y, w - 0.24, h - 0.35)
      for (const e of ECHOES) {
        slide.addShape(pptx.ShapeType.rect, { ...box, x: box.x + e.dx * 2.4, fill: { color: accent, transparency: e.transparency }, line: { type: 'none' } })
      }
      slide.addImage({ data: picture.dataURL, ...box })
      slide.addText(picture.credit, { x: x, y: box.y + box.h + 0.05, w, h: 0.3, fontFace: FONT, fontSize: 9, color: muted, align: 'right' })
    }

    switch (s.layout) {
      case 'title':
      case 'section': {
        if (s.layout === 'section') part += 1
        const tw = picture ? 6.6 : W - 2 * M
        label(s.layout === 'section' ? `Part ${pad(part)}` : 'Presented by ECHO', { x: M + 0.1, y: 2.05, w: tw, h: 0.5 })
        echoed(s.title, { x: M + 0.1, y: 2.55, w: tw, h: 2, fontFace: FONT, fontSize: s.layout === 'title' ? 50 : 44, bold: true, color: text, valign: 'top', fit: 'shrink' })
        if (s.subtitle) slide.addText(s.subtitle, { x: M + 0.1, y: 4.6, w: tw, h: 1.1, fontFace: FONT, fontSize: 20, color: muted, valign: 'top', fit: 'shrink' })
        image(7.75, 0.75, W - 7.75 - M, H - 1.7)
        break
      }
      case 'image':
        heading()
        if (s.bullets?.length) bullets(s.bullets, M, 1.95, 5.3, 4.6, 20)
        image(s.bullets?.length ? 6.4 : M, 1.85, s.bullets?.length ? W - 6.4 - M : W - 2 * M, 4.9)
        break
      case 'quote':
        if (s.title) label(s.title, { x: 1.4, y: 1.2, w: W - 2.8, h: 0.5 })
        echoed('“', { x: 0.7, y: 1.35, w: 1, h: 1.4, fontFace: FONT, fontSize: 110, bold: true, color: accent })
        slide.addText(`${s.quote!.text}”`, { x: 1.4, y: 1.8, w: W - 2.8, h: 3.4, fontFace: FONT, fontSize: 32, bold: true, color: text, valign: 'middle', fit: 'shrink' })
        if (s.quote!.by) label(s.quote!.by, { x: 1.4, y: 5.35, w: W - 2.8, h: 0.5 })
        break
      case 'stats': {
        heading()
        const stats = s.stats!
        const gap = 0.35
        const bw = (W - 2 * M - gap * (stats.length - 1)) / stats.length
        stats.forEach((st, i) => {
          const x = M + i * (bw + gap)
          card(x, 2.05, bw, 3.9)
          echoed(st.value, { x: x + 0.35, y: 2.45, w: bw - 0.6, h: 1.6, fontFace: FONT, fontSize: 54, bold: true, color: accentText, fit: 'shrink' })
          slide.addText(st.label, { x: x + 0.35, y: 4.1, w: bw - 0.6, h: 1.5, fontFace: FONT, fontSize: 16, color: text, valign: 'top', fit: 'shrink' })
        })
        break
      }
      case 'compare': {
        heading()
        const cw = (W - 2 * M - 0.35) / 2
        const columns: Array<[string | undefined, string[]]> = [
          [s.leftTitle, s.bullets!],
          [s.rightTitle, s.right!]
        ]
        columns.forEach(([title, items], i) => {
          const x = M + i * (cw + 0.35)
          card(x, 1.9, cw, 4.7)
          if (title) label(title, { x: x + 0.4, y: 2.15, w: cw - 0.8, h: 0.5 })
          bullets(items, x + 0.4, title ? 2.8 : 2.2, cw - 0.8, 3.6, 18)
        })
        break
      }
      case 'closing':
        echoed(s.title, { x: M + 0.1, y: s.bullets?.length ? 1.1 : 2.4, w: W - 2 * M, h: 1.6, fontFace: FONT, fontSize: 46, bold: true, color: text, align: 'center', valign: 'middle', fit: 'shrink' })
        if (s.subtitle) slide.addText(s.subtitle, { x: M, y: s.bullets?.length ? 2.7 : 4.0, w: W - 2 * M, h: 0.8, fontFace: FONT, fontSize: 20, color: muted, align: 'center' })
        if (s.bullets?.length) bullets(s.bullets, 3.2, 3.7, W - 6.4, 2.6, 20)
        break
      default:
        heading()
        bullets(s.bullets ?? [], M, 1.95, W - 2 * M, 4.7)
    }

    // Footer: the ECHO mark, and the page number on all but the title slide.
    if (markPath) slide.addImage({ path: markPath, x: M, y: H - 0.72, w: 0.32, h: 0.32, rounding: false })
    slide.addText('ECHO', { x: M + (markPath ? 0.45 : 0), y: H - 0.74, w: 2, h: 0.36, fontFace: LABEL_FONT, fontSize: 12, bold: true, color: muted, charSpacing: 3 })
    if (s.layout !== 'title') {
      slide.addText(`${pad(index + 1)} / ${pad(deck.slides.length)}`, { x: W - M - 2, y: H - 0.74, w: 2, h: 0.36, fontFace: LABEL_FONT, fontSize: 12, bold: true, color: muted, align: 'right', charSpacing: 2 })
    }
    if (s.notes) slide.addNotes(s.notes)
  })
  const out = await pptx.write({ outputType: 'nodebuffer' })
  return Buffer.from(out as Uint8Array)
}
