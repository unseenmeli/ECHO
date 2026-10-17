import type { BoardElement } from '../../shared/board'
import { union, type Rect } from './layout'

/** Metadata stamped (as Excalidraw `customData.echo`) on every element the lesson draws. */
export interface EchoMeta {
  /** Logical id the agents use. */
  id: string
  kind: 'node' | 'edge' | 'title' | 'part' | 'ring' | 'note' | 'group'
  /** Diagram / chart / table block this belongs to. */
  block?: string
  seg?: string
  from?: string
  to?: string
  label?: string
  detail?: string
  color?: string
  shape?: string
}

export const ECHO_PREFIX = 'echo:'
export const eid = (logical: string): string => ECHO_PREFIX + logical
export const USER_REF = 'user:'

export interface WorldElement {
  id: string
  type: string
  rect: Rect
  echo?: EchoMeta
  /** Own text (text elements) or the text bound to this container. */
  text?: string
  containerId?: string | null
  boundIds: string[]
  opacity: number
}

const rectOf = (e: BoardElement): Rect => ({ x: e.x, y: e.y, w: Math.abs(e.width), h: Math.abs(e.height) })

/** Read-only-ish model of the current board, updated as a plan's operations are translated. */
export class World {
  readonly elements = new Map<string, WorldElement>()

  static from(elements: BoardElement[]): World {
    const w = new World()
    const bound = new Map<string, string>() // text id -> container id
    for (const e of elements) if (e.isDeleted !== true && e.type === 'text' && typeof e.containerId === 'string') bound.set(e.id, e.containerId)
    for (const e of elements) {
      if (e.isDeleted === true) continue
      const echo = (e.customData as { echo?: EchoMeta } | undefined)?.echo
      w.elements.set(e.id, {
        id: e.id,
        type: e.type,
        rect: rectOf(e),
        echo,
        text: typeof e.text === 'string' ? e.text : undefined,
        containerId: typeof e.containerId === 'string' ? e.containerId : null,
        boundIds: Array.isArray(e.boundElements) ? (e.boundElements as Array<{ id: string }>).map((b) => b.id) : [],
        opacity: typeof e.opacity === 'number' ? e.opacity : 100
      })
    }
    // Containers learn their label text from their bound text element.
    for (const [textId, containerId] of bound) {
      const t = w.elements.get(textId)
      const c = w.elements.get(containerId)
      if (t && c) c.text = t.text
    }
    return w
  }

  add(el: WorldElement): void {
    this.elements.set(el.id, el)
  }

  remove(id: string): void {
    this.elements.delete(id)
  }

  /** Element for a logical id (AI-created) or a `user:<id>` reference. */
  resolve(ref: string): WorldElement | undefined {
    if (ref.startsWith(USER_REF)) {
      const e = this.elements.get(ref.slice(USER_REF.length))
      return e && !e.echo ? e : undefined
    }
    return this.elements.get(eid(ref))
  }

  /** Elements that belong to a block (diagram/chart/table) or are the block's own element. */
  blockMembers(blockId: string): WorldElement[] {
    return [...this.elements.values()].filter((e) => e.echo && (e.echo.block === blockId || e.echo.id === blockId))
  }

  /** Logical ids that already exist (cannot be reused for new things). */
  hasLogical(id: string): boolean {
    return this.elements.has(eid(id))
  }

  /** Everything new content should avoid: every non-label element. */
  obstacles(): Rect[] {
    return [...this.elements.values()].filter((e) => !(e.type === 'text' && e.containerId)).map((e) => e.rect)
  }

  echoElements(): WorldElement[] {
    return [...this.elements.values()].filter((e) => e.echo)
  }

  userElements(): WorldElement[] {
    return [...this.elements.values()].filter((e) => !e.echo && !(e.type === 'text' && e.containerId))
  }

  bounds(ids: string[]): Rect | null {
    return union(ids.map((i) => this.elements.get(i)?.rect).filter((r): r is Rect => !!r))
  }
}
