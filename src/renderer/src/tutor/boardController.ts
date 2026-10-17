import { CaptureUpdateAction, convertToExcalidrawElements } from '@excalidraw/excalidraw'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import type { BoardApi, BoardElement, ElementPatch, ElementSkeleton } from '../../../shared/board'

const newNonce = (): number => Math.floor(Math.random() * 2 ** 31)

// Excalidraw reconciles by (version, versionNonce); every programmatic change
// must bump the version or it can be treated as stale.
const bumped = (prev: ExcalidrawElement, next: Partial<ExcalidrawElement>): ExcalidrawElement =>
  ({ ...prev, ...next, version: prev.version + 1, versionNonce: newNonce(), updated: Date.now() }) as ExcalidrawElement

const toBoardElement = (e: ExcalidrawElement): BoardElement => JSON.parse(JSON.stringify(e)) as BoardElement

/**
 * BoardApi on top of a live Excalidraw instance. Every method edits the same
 * scene the user is drawing on, incrementally: the camera and untouched
 * elements are never reset.
 */
export function createBoardController(api: ExcalidrawImperativeAPI): BoardApi {
  const all = (): readonly ExcalidrawElement[] => api.getSceneElementsIncludingDeleted()
  const commit = (elements: readonly ExcalidrawElement[]): void =>
    api.updateScene({ elements, captureUpdate: CaptureUpdateAction.IMMEDIATELY })

  return {
    async getScene() {
      const { scrollX, scrollY, zoom } = api.getAppState()
      return {
        elements: api.getSceneElements().map(toBoardElement),
        viewport: { scrollX, scrollY, zoom: zoom.value }
      }
    },

    async getSelected() {
      const ids = api.getAppState().selectedElementIds
      return api
        .getSceneElements()
        .filter((e) => ids[e.id])
        .map(toBoardElement)
    },

    async upsertElements(skeletons: ElementSkeleton[]) {
      const converted = convertToExcalidrawElements(skeletons as never, { regenerateIds: false })
      const next = [...all()]
      const indexById = new Map(next.map((e, i) => [e.id, i]))
      for (const el of converted) {
        const at = indexById.get(el.id)
        if (at === undefined) {
          indexById.set(el.id, next.push(el) - 1)
        } else {
          next[at] = bumped(next[at], { ...el, index: next[at].index, isDeleted: false })
        }
      }
      commit(next)
      return converted.map((e) => e.id)
    },

    async updateElements(patches: ElementPatch[]) {
      const byId = new Map(patches.map((p) => [p.id, p.changes]))
      const updated: string[] = []
      const shift = new Map<string, { dx: number; dy: number }>() // bound labels follow their container
      const next = all().map((e) => {
        const changes = byId.get(e.id)
        if (!changes || e.isDeleted) return e
        updated.push(e.id)
        // Identity and versioning are not patchable.
        const { id: _id, type: _type, version: _v, versionNonce: _n, ...safe } = changes
        const dx = typeof safe.x === 'number' ? safe.x - e.x : 0
        const dy = typeof safe.y === 'number' ? safe.y - e.y : 0
        if (dx || dy) for (const b of e.boundElements ?? []) if (b.type === 'text') shift.set(b.id, { dx, dy })
        return bumped(e, safe as Partial<ExcalidrawElement>)
      })
      const moved = next.map((e) => {
        const s = shift.get(e.id)
        return s && !byId.has(e.id) ? bumped(e, { x: e.x + s.dx, y: e.y + s.dy }) : e
      })
      if (updated.length) commit(moved)
      return updated
    },

    async deleteElements(ids: string[]) {
      const set = new Set(ids)
      // A container's bound label goes with it.
      for (const e of all()) if (set.has(e.id)) for (const b of e.boundElements ?? []) if (b.type === 'text') set.add(b.id)
      const deleted: string[] = []
      const next = all().map((e) => {
        if (!set.has(e.id) || e.isDeleted) return e
        deleted.push(e.id)
        return bumped(e, { isDeleted: true })
      })
      if (deleted.length) commit(next)
      return deleted
    },

    async clear() {
      commit(all().map((e) => (e.isDeleted ? e : bumped(e, { isDeleted: true }))))
    }
  }
}
