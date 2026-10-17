import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import type { BoardApi } from '../../../shared/board'
import type { RunLanguage, RunResult } from './codeRunner'

// Code cards are drawn by the lesson (src/main/lesson/translate.ts). Python and JavaScript ones get an HTML Run
// button floated over the right end of their header; the result is written into the card's output strip, where
// the next lesson turn reads it from the board.

const RUNNABLE: readonly string[] = ['python', 'javascript'] satisfies RunLanguage[]
const OUTPUT = { font: 15, family: 3, maxLines: 5, text: '#f5f4f0', error: '#ff8a80', muted: '#8a8f98' }
/** Below this zoom the button would cover the card, so it is hidden. */
const MIN_ZOOM = 0.3

export interface CodeCard {
  block: string
  language: RunLanguage
  code: string
  /** Top-right corner of the card, in board pixels. */
  right: number
  top: number
  zoom: number
}

interface EchoMeta {
  id: string
  kind: string
  block?: string
  language?: string
  code?: string
  detail?: string
}
const echoOf = (e: ExcalidrawElement): EchoMeta | undefined => (e.customData as { echo?: EchoMeta } | undefined)?.echo

export function findCodeCards(
  elements: readonly ExcalidrawElement[],
  view: { scrollX: number; scrollY: number; zoom: number }
): CodeCard[] {
  if (view.zoom < MIN_ZOOM) return []
  const cards: CodeCard[] = []
  for (const e of elements) {
    const echo = echoOf(e)
    if (e.isDeleted || echo?.kind !== 'code' || !RUNNABLE.includes(echo.language ?? '')) continue
    cards.push({
      block: echo.id,
      language: echo.language as RunLanguage,
      code: echo.code ?? '',
      right: (e.x + e.width + view.scrollX) * view.zoom,
      top: (e.y + view.scrollY) * view.zoom,
      zoom: view.zoom
    })
  }
  return cards
}

/** Replaces the text in a card's output strip. `ran` marks real output, which the lesson then sees. */
export async function writeCodeOutput(
  board: BoardApi,
  block: string,
  text: string,
  tone: 'output' | 'error' | 'status',
  ran: boolean
): Promise<void> {
  const { elements } = await board.getScene()
  const target = elements.find((e) => e.id === `echo:${block}__out_text`)
  const strip = elements.find((e) => e.id === `echo:${block}__out`)
  if (!target) return
  const maxChars = Math.max(20, Math.floor(((strip?.width ?? 400) - 24) / (OUTPUT.font * 0.6)))
  let lines = (text || '(no output)').split('\n').map((l) => (l.length > maxChars ? l.slice(0, maxChars - 1) + '…' : l))
  if (lines.length > OUTPUT.maxLines) {
    const more = lines.length - (OUTPUT.maxLines - 1)
    lines = [...lines.slice(0, OUTPUT.maxLines - 1), `… ${more} more line${more === 1 ? '' : 's'}`]
  }
  const meta = { ...(target.customData as { echo: EchoMeta }).echo, detail: ran ? 'ran' : undefined }
  await board.upsertElements([
    {
      type: 'text',
      id: target.id,
      x: target.x,
      y: target.y,
      text: lines.join('\n'),
      fontSize: OUTPUT.font,
      fontFamily: OUTPUT.family,
      strokeColor: tone === 'error' ? OUTPUT.error : tone === 'status' ? OUTPUT.muted : OUTPUT.text,
      textAlign: 'left',
      roughness: 0,
      customData: { echo: meta }
    }
  ])
}

/** What a run printed, with the error (if any) after it. */
export function describeRun(r: RunResult): { text: string; tone: 'output' | 'error' } {
  const output = r.output.replace(/\s+$/, '')
  if (!r.error) return { text: output, tone: 'output' }
  return { text: output ? `${output}\n${r.error}` : r.error, tone: 'error' }
}

export function CodeRunButtons({
  cards,
  running,
  onRun
}: {
  cards: CodeCard[]
  running: ReadonlySet<string>
  onRun(card: CodeCard): void
}) {
  if (!cards.length) return null
  return (
    <div className="code-run-layer">
      {cards.map((card) => {
        const busy = running.has(card.block)
        return (
          <button
            key={card.block}
            className="code-run-button"
            style={{ left: card.right - 12 * card.zoom, top: card.top + 7 * card.zoom, transform: `translateX(-100%) scale(${card.zoom})` }}
            disabled={busy}
            title={`Run this ${card.language === 'python' ? 'Python' : 'JavaScript'}`}
            onClick={() => onRun(card)}
          >
            <svg viewBox="0 0 12 12" aria-hidden="true">
              <path d="M3 1.8v8.4L10 6z" />
            </svg>
            {busy ? 'Running…' : 'Run'}
          </button>
        )
      })}
    </div>
  )
}
