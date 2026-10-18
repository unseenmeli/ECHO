import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { THEMES, type Deck, type DeckView, type Slide } from '../../../shared/deck'
import avatarSrc from '../assets/echo-avatar.png'

// Slides are laid out on a fixed 1280×720 canvas and scaled to the window. The same canvas is one 13.333×7.5in page
// when the window is printed to PDF, so the file looks exactly like the screen.
const SLIDE_W = 1280
const SLIDE_H = 720
const isMac = navigator.userAgent.includes('Mac')

function themeStyle(deck: Deck): CSSProperties {
  const t = THEMES[deck.theme]
  return {
    '--bg': t.background,
    '--surface': t.surface,
    '--text': t.text,
    '--muted': t.muted,
    '--accent': t.accent,
    '--accent-text': t.accentText,
    '--dot': t.dot
  } as CSSProperties
}

const pad = (n: number): string => String(n).padStart(2, '0')

function Bullets({ items }: { items?: string[] }) {
  if (!items?.length) return null
  return (
    <ul className="s-bullets">
      {items.map((b, i) => (
        <li key={i}>{b}</li>
      ))}
    </ul>
  )
}

/** A picture in a frame trailed by pink afterimages, as on the app icon. */
function Picture({ slide }: { slide: Slide }) {
  if (!slide.image) return null
  if (slide.picture === undefined) return <div className="s-picture is-loading" />
  if (!slide.picture) return null
  return (
    <figure className="s-picture">
      <div className="s-frame">
        <img src={slide.picture.dataURL} alt={slide.image.search} />
      </div>
      <figcaption>{slide.picture.credit}</figcaption>
    </figure>
  )
}

/** A heading with ECHO's pink afterimages and, on the big slides, the pink caret. */
function Echoed({ text, caret }: { text: string; caret?: boolean }) {
  return (
    <h1 className="s-echoed">
      {text}
      {caret && <span className="s-caret" />}
    </h1>
  )
}

function SlideBody({ slide, part }: { slide: Slide; part: number }) {
  const withPicture = !!slide.image && slide.picture !== null
  switch (slide.layout) {
    case 'title':
    case 'section':
      return (
        <div className={`s-hero ${withPicture ? 'has-picture' : ''}`}>
          <div className="s-hero-text">
            <p className="s-kicker">{slide.layout === 'section' ? `Part ${pad(part)}` : 'Presented by ECHO'}</p>
            <Echoed text={slide.title} caret={slide.layout === 'title'} />
            {slide.subtitle && <p className="s-sub">{slide.subtitle}</p>}
          </div>
          <Picture slide={slide} />
        </div>
      )
    case 'image':
      return (
        <>
          <h2>{slide.title}</h2>
          <div className={`s-split ${slide.bullets?.length ? '' : 'is-solo'}`}>
            <Bullets items={slide.bullets} />
            <Picture slide={slide} />
          </div>
        </>
      )
    case 'quote':
      return (
        <div className="s-quote">
          {slide.title && <p className="s-kicker">{slide.title}</p>}
          <blockquote>
            <span className="s-quote-mark">“</span>
            {slide.quote!.text}”
          </blockquote>
          {slide.quote!.by && <p className="s-by">{slide.quote!.by}</p>}
        </div>
      )
    case 'stats':
      return (
        <>
          <h2>{slide.title}</h2>
          <div className="s-stats">
            {slide.stats!.map((s, i) => (
              <div className="s-card s-stat" key={i}>
                <strong className="s-echoed">{s.value}</strong>
                <span>{s.label}</span>
              </div>
            ))}
          </div>
        </>
      )
    case 'compare':
      return (
        <>
          <h2>{slide.title}</h2>
          <div className="s-compare">
            <section className="s-card">
              {slide.leftTitle && <h3>{slide.leftTitle}</h3>}
              <Bullets items={slide.bullets} />
            </section>
            <section className="s-card">
              {slide.rightTitle && <h3>{slide.rightTitle}</h3>}
              <Bullets items={slide.right} />
            </section>
          </div>
        </>
      )
    case 'closing':
      return (
        <div className="s-closing">
          <Echoed text={slide.title} caret />
          {slide.subtitle && <p className="s-sub">{slide.subtitle}</p>}
          <Bullets items={slide.bullets} />
        </div>
      )
    default:
      return (
        <>
          <h2>{slide.title}</h2>
          <Bullets items={slide.bullets} />
        </>
      )
  }
}

function SlideCanvas({ deck, index }: { deck: Deck; index: number }) {
  const slide = deck.slides[index]
  const part = deck.slides.slice(0, index + 1).filter((s) => s.layout === 'section').length
  return (
    <article className={`slide t-${deck.theme} l-${slide.layout}`} style={themeStyle(deck)}>
      <SlideBody slide={slide} part={part} />
      <footer className="s-foot">
        <span className="s-mark">
          <img src={avatarSrc} alt="" />
          ECHO
        </span>
        {slide.layout !== 'title' && (
          <span className="s-page">
            {pad(index + 1)} / {pad(deck.slides.length)}
          </span>
        )}
      </footer>
    </article>
  )
}

/** The scale that fits a 1280×720 slide into the stage. */
function useFit(ref: React.RefObject<HTMLDivElement | null>): number {
  const [scale, setScale] = useState(0.5)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const update = (): void => setScale(Math.min(el.clientWidth / SLIDE_W, el.clientHeight / SLIDE_H))
    update()
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return scale
}

/** The deck ECHO is building or has built: one slide at a time on screen, every slide when printed. */
export function DeckWindow() {
  const [view, setView] = useState<DeckView | null>(null)
  const stage = useRef<HTMLDivElement>(null)
  const scale = useFit(stage)

  useEffect(() => {
    const off = window.deck.onShow(setView)
    void window.deck.get().then((v) => v && setView(v))
    return off
  }, [])

  // Tell the app once this version is drawn (pictures and the pixel font loaded), so a PDF printed now has
  // everything on it.
  const version = view?.deck?.version
  useEffect(() => {
    if (version === undefined) return
    let cancelled = false
    void Promise.all([document.fonts.ready, ...[...document.images].map((img) => img.decode().catch(() => {}))]).then(() => {
      if (!cancelled) window.deck.rendered(version)
    })
    return () => {
      cancelled = true
    }
  }, [version])

  const deck = view?.deck ?? null
  const count = deck?.slides.length ?? 0
  const current = Math.min(view?.current ?? 0, Math.max(0, count - 1))

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!count) return
      if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'PageDown') window.deck.select(Math.min(current + 1, count - 1))
      if (e.key === 'ArrowLeft' || e.key === 'PageUp') window.deck.select(Math.max(current - 1, 0))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [current, count])

  const status = view?.status
  const working = status?.kind === 'building' || status?.kind === 'revising'

  return (
    <>
      <main className={`deck-screen ${isMac ? 'platform-mac' : ''}`}>
        <header className="deck-bar">
          <img className="deck-avatar" src={avatarSrc} alt="" draggable={false} />
          <h1 className="deck-title">
            {deck?.title ?? 'Presentation'}
            {working && <span className="deck-cursor" />}
          </h1>
          {status?.message && <span className={`deck-status is-${status.kind}`}>{status.message}</span>}
        </header>

        <div className="deck-stage" ref={stage}>
          {deck && count ? (
            <div className="deck-fit" style={{ width: SLIDE_W * scale, height: SLIDE_H * scale }}>
              <div key={`${deck.id}-${current}`} className="deck-scaled" style={{ transform: `scale(${scale})` }}>
                <SlideCanvas deck={deck} index={current} />
              </div>
            </div>
          ) : (
            <div className="deck-empty">
              <img className="deck-empty-art" src={avatarSrc} alt="" draggable={false} />
              <p className="deck-empty-title">{status?.kind === 'failed' ? 'No deck this time' : 'Writing your deck'}</p>
              <p className="deck-empty-body">{status?.kind === 'failed' ? status.message : 'Slides appear here as ECHO writes them.'}</p>
            </div>
          )}
        </div>

        <footer className="deck-foot">
          <div className="deck-pill">
            <button className="deck-nav" disabled={current <= 0} onClick={() => window.deck.select(current - 1)} aria-label="Previous slide">
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M10 3 5 8l5 5" />
              </svg>
            </button>
            <span className="deck-count">{count ? `${pad(current + 1)} / ${pad(count)}` : '-- / --'}</span>
            <button className="deck-nav" disabled={current >= count - 1} onClick={() => window.deck.select(current + 1)} aria-label="Next slide">
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="m6 3 5 5-5 5" />
              </svg>
            </button>
          </div>
          <p className="deck-hint">{working ? 'Slides appear as ECHO writes them' : 'Say “next slide”, “change slide 3” or “save it”'}</p>
        </footer>
      </main>

      {deck && (
        <div className="deck-print">
          {deck.slides.map((_, i) => (
            <SlideCanvas key={i} deck={deck} index={i} />
          ))}
        </div>
      )}
    </>
  )
}
