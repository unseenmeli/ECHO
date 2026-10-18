import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react'
import { THEMES, type Deck, type DeckView, type Slide } from '../../../shared/deck'

// Slides are laid out on a fixed 1280×720 canvas and scaled to the window. The same canvas is one 13.333×7.5in page
// when the window is printed to PDF, so the file looks exactly like the screen.
const SLIDE_W = 1280
const SLIDE_H = 720

function themeStyle(deck: Deck): CSSProperties {
  const t = THEMES[deck.theme]
  return {
    '--bg': t.background,
    '--surface': t.surface,
    '--text': t.text,
    '--muted': t.muted,
    '--accent': t.accent
  } as CSSProperties
}

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

function Picture({ slide }: { slide: Slide }) {
  if (!slide.image) return null
  if (slide.picture === undefined) return <div className="s-picture is-loading" />
  if (!slide.picture) return null
  return (
    <figure className="s-picture">
      <img src={slide.picture.dataURL} alt={slide.image.search} />
      <figcaption>{slide.picture.credit}</figcaption>
    </figure>
  )
}

function SlideBody({ slide }: { slide: Slide }) {
  const withPicture = !!slide.image && slide.picture !== null
  switch (slide.layout) {
    case 'title':
    case 'section':
      return (
        <div className={`s-hero ${withPicture ? 'has-picture' : ''}`}>
          <div className="s-hero-text">
            {slide.layout === 'section' && <div className="s-rule" />}
            <h1>{slide.title}</h1>
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
          <blockquote>“{slide.quote!.text}”</blockquote>
          {slide.quote!.by && <p className="s-by">— {slide.quote!.by}</p>}
        </div>
      )
    case 'stats':
      return (
        <>
          <h2>{slide.title}</h2>
          <div className="s-stats">
            {slide.stats!.map((s, i) => (
              <div className="s-stat" key={i}>
                <strong>{s.value}</strong>
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
            <section>
              {slide.leftTitle && <h3>{slide.leftTitle}</h3>}
              <Bullets items={slide.bullets} />
            </section>
            <section>
              {slide.rightTitle && <h3>{slide.rightTitle}</h3>}
              <Bullets items={slide.right} />
            </section>
          </div>
        </>
      )
    case 'closing':
      return (
        <div className="s-closing">
          <h1>{slide.title}</h1>
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

function SlideCanvas({ deck, slide, index }: { deck: Deck; slide: Slide; index: number }) {
  return (
    <article className={`slide l-${slide.layout}`} style={themeStyle(deck)}>
      <SlideBody slide={slide} />
      {slide.layout !== 'title' && <span className="s-number">{index + 1}</span>}
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

  // Tell the app once this version is drawn (pictures decoded), so a PDF printed now has everything on it.
  const version = view?.deck?.version
  useEffect(() => {
    if (version === undefined) return
    let cancelled = false
    void Promise.all([...document.images].map((img) => img.decode().catch(() => {}))).then(() => {
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
  const slide = deck?.slides[current]

  return (
    <>
      <main className="deck-screen">
        <header className="deck-bar">
          <span className="deck-title">{deck?.title ?? 'Presentation'}</span>
          {status?.message && <span className={`deck-status is-${status.kind}`}>{status.message}</span>}
        </header>

        <div className="deck-stage" ref={stage}>
          {deck && slide ? (
            <div className="deck-fit" style={{ width: SLIDE_W * scale, height: SLIDE_H * scale }}>
              <div key={`${deck.id}-${current}`} className="deck-scaled" style={{ transform: `scale(${scale})` }}>
                <SlideCanvas deck={deck} slide={slide} index={current} />
              </div>
            </div>
          ) : (
            <div className="deck-empty">
              {status?.kind === 'failed' ? status.message : <><span className="deck-spinner" /> {status?.message || 'Writing your deck…'}</>}
            </div>
          )}
        </div>

        <footer className="deck-foot">
          <button className="deck-nav" disabled={current <= 0} onClick={() => window.deck.select(current - 1)} aria-label="Previous slide">
            ‹
          </button>
          <span className="deck-count">{count ? `${current + 1} / ${count}` : ''}</span>
          <button className="deck-nav" disabled={current >= count - 1} onClick={() => window.deck.select(current + 1)} aria-label="Next slide">
            ›
          </button>
          <span className="deck-hint">{working ? 'Slides appear as ECHO writes them' : 'Say “next slide”, “change slide 3…” or “save it”'}</span>
        </footer>
      </main>

      {deck && (
        <div className="deck-print">
          {deck.slides.map((s, i) => (
            <SlideCanvas key={i} deck={deck} slide={s} index={i} />
          ))}
        </div>
      )}
    </>
  )
}
