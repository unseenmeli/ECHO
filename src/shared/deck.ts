// Slide decks ECHO builds by voice. The model writes the deck as JSON lines (one header line, then one line per
// slide); the app checks every line, finds the pictures, shows the deck in its own window and exports it to PDF or
// PowerPoint. Nothing here is ever filled in by the user.

export const THEMES = {
  midnight: { background: '#14162b', surface: '#1f2240', text: '#f4f2ff', muted: '#a9a6c9', accent: '#ff6fa8' },
  paper: { background: '#f6f1e7', surface: '#ebe3d3', text: '#22201c', muted: '#6d665a', accent: '#d2502e' },
  ocean: { background: '#0d2a3a', surface: '#123a50', text: '#eef8ff', muted: '#9cc3d8', accent: '#3fd0c9' },
  forest: { background: '#f1f5ee', surface: '#dfe9d8', text: '#1d2a1b', muted: '#5b6e56', accent: '#2f8a4c' },
  sunset: { background: '#2b1622', surface: '#3d1f30', text: '#fff3ea', muted: '#d7aebd', accent: '#ffb347' }
} as const

export type ThemeId = keyof typeof THEMES
export const THEME_IDS = Object.keys(THEMES) as ThemeId[]

export const LAYOUTS = ['title', 'section', 'bullets', 'image', 'quote', 'stats', 'compare', 'closing'] as const
export type SlideLayout = (typeof LAYOUTS)[number]

export interface SlidePicture {
  dataURL: string
  width: number
  height: number
  /** "Author · License · Wikimedia Commons" */
  credit: string
}

export interface Slide {
  layout: SlideLayout
  title: string
  subtitle?: string
  /** bullets, image (beside the picture) and compare (the left column). */
  bullets?: string[]
  /** compare only: the right column and both column headings. */
  right?: string[]
  leftTitle?: string
  rightTitle?: string
  quote?: { text: string; by?: string }
  stats?: Array<{ value: string; label: string }>
  /** What to look up on Wikimedia Commons. */
  image?: { search: string }
  /** The picture once found (null: looked for, none found). */
  picture?: SlidePicture | null
  /** What the presenter says on this slide. */
  notes: string
}

export interface DeckHeader {
  title: string
  subtitle?: string
  theme: ThemeId
}

export interface Deck extends DeckHeader {
  id: string
  /** Bumped on every change, so the window can tell when it has drawn the latest. */
  version: number
  slides: Slide[]
}

/** What the deck window shows. */
export interface DeckView {
  deck: Deck | null
  /** The slide on screen (0-based). */
  current: number
  /** Building or revising: the slides so far are shown with this note. */
  status: { kind: 'building' | 'revising' | 'ready' | 'failed'; message: string }
}

export const MAX_SLIDES = 20
const MAX_TEXT = 300
const MAX_NOTES = 1500
const MAX_ITEMS = 6

function text(v: unknown, max = MAX_TEXT): string {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : ''
}

function list(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => text(x, 200)).filter(Boolean).slice(0, MAX_ITEMS) : []
}

/** The header line, or null when it isn't one. */
export function parseHeader(raw: unknown): DeckHeader | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (r.kind !== 'deck') return null
  const title = text(r.title, 120)
  if (!title) return null
  const theme = THEME_IDS.includes(r.theme as ThemeId) ? (r.theme as ThemeId) : 'midnight'
  const subtitle = text(r.subtitle, 200)
  return { title, theme, ...(subtitle ? { subtitle } : {}) }
}

/** One slide line, checked and trimmed to what its layout uses. Null when it can't be shown. */
export function parseSlide(raw: unknown): Slide | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (r.kind !== undefined && r.kind !== 'slide') return null
  const layout: SlideLayout = (LAYOUTS as readonly string[]).includes(r.layout as string) ? (r.layout as SlideLayout) : 'bullets'
  const title = text(r.title, 140)
  const slide: Slide = { layout, title, notes: text(r.notes, MAX_NOTES) }
  const subtitle = text(r.subtitle, 200)
  if (subtitle) slide.subtitle = subtitle
  const bullets = list(r.bullets)
  if (bullets.length) slide.bullets = bullets
  const search = text((r.image as Record<string, unknown> | undefined)?.search, 100)
  if (search && (layout === 'image' || layout === 'title' || layout === 'section')) slide.image = { search }
  switch (layout) {
    case 'compare': {
      const right = list(r.right)
      if (!bullets.length || !right.length) return title ? { ...slide, layout: 'bullets' } : null
      slide.right = right
      slide.leftTitle = text(r.leftTitle, 60)
      slide.rightTitle = text(r.rightTitle, 60)
      break
    }
    case 'quote': {
      const q = r.quote as Record<string, unknown> | undefined
      const quote = text(q?.text, 400)
      if (!quote) return title ? { ...slide, layout: 'bullets' } : null
      const by = text(q?.by, 80)
      slide.quote = { text: quote, ...(by ? { by } : {}) }
      break
    }
    case 'stats': {
      const stats = (Array.isArray(r.stats) ? r.stats : [])
        .map((s) => ({ value: text((s as Record<string, unknown>)?.value, 16), label: text((s as Record<string, unknown>)?.label, 80) }))
        .filter((s) => s.value && s.label)
        .slice(0, 4)
      if (!stats.length) return title ? { ...slide, layout: 'bullets' } : null
      slide.stats = stats
      break
    }
    case 'image':
      if (!slide.image) slide.layout = 'bullets'
      break
  }
  if (!slide.title && !slide.quote && !slide.stats) return null
  return slide
}

/**
 * Reads the model's JSON lines as they stream in. Lines that aren't JSON (a sentence before the deck, a code fence)
 * are skipped, so a chatty reply still yields a deck.
 */
export class DeckLineParser {
  private buffer = ''
  header: DeckHeader | null = null
  readonly slides: Slide[] = []

  /** Feeds streamed text; returns true when a header or slide was added. */
  push(delta: string): boolean {
    this.buffer += delta
    let changed = false
    let nl: number
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      changed = this.line(this.buffer.slice(0, nl)) || changed
      this.buffer = this.buffer.slice(nl + 1)
    }
    return changed
  }

  end(): boolean {
    const changed = this.line(this.buffer)
    this.buffer = ''
    return changed
  }

  private line(raw: string): boolean {
    const s = raw.trim()
    if (!s.startsWith('{') || !s.endsWith('}')) return false
    let obj: unknown
    try {
      obj = JSON.parse(s)
    } catch {
      return false
    }
    if (!this.header) {
      const header = parseHeader(obj)
      if (header) {
        this.header = header
        return true
      }
    }
    if (this.slides.length >= MAX_SLIDES) return false
    const slide = parseSlide(obj)
    if (!slide) return false
    this.slides.push(slide)
    return true
  }
}

/** A deck written back as the same JSON lines (pictures left out), so the model can revise it. */
export function deckToLines(deck: Deck): string {
  const header = { kind: 'deck', title: deck.title, ...(deck.subtitle ? { subtitle: deck.subtitle } : {}), theme: deck.theme }
  const slides = deck.slides.map(({ picture: _picture, ...s }) => JSON.stringify({ kind: 'slide', ...s }))
  return [JSON.stringify(header), ...slides].join('\n')
}

/** A file name from the deck title: letters, digits, spaces and a few safe marks only. */
export function deckFileName(title: string): string {
  const name = title
    .replace(/[^\p{L}\p{N} \-_,.()&]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 80)
  return name || 'Presentation'
}
