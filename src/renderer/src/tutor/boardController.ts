import { CaptureUpdateAction, convertToExcalidrawElements } from '@excalidraw/excalidraw'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import type { BatchResult, BoardApi, BoardBatch, BoardElement, ElementPatch, ElementSkeleton } from '../../../shared/board'

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
      const { scrollX, scrollY, zoom, width, height } = api.getAppState()
      return {
        elements: api.getSceneElements().map(toBoardElement),
        viewport: { scrollX, scrollY, zoom: zoom.value, width, height }
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
      const converted = normalizeLinearBounds(convertToExcalidrawElements(skeletons as never, { regenerateIds: false }))
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
      removeOrphanedLabels(next, converted)
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
    },

    async applyBatch(batch: BoardBatch): Promise<BatchResult> {
      const next = [...all()]
      const indexOf = (): Map<string, number> => new Map(next.map((e, i) => [e.id, i]))
      const result: BatchResult = { upserted: [], patched: [], removed: [] }

      // 1. Removals (a container's bound labels go with it).
      if (batch.remove.length) {
        const doomed = new Set(batch.remove)
        for (const e of next) if (doomed.has(e.id)) for (const b of e.boundElements ?? []) if (b.type === 'text') doomed.add(b.id)
        next.forEach((e, i) => {
          if (doomed.has(e.id) && !e.isDeleted) {
            next[i] = bumped(e, { isDeleted: true })
            result.removed.push(e.id)
          }
        })
      }

      // 2. New / replaced elements.
      if (batch.upsert.length) {
        const converted = normalizeLinearBounds(convertToExcalidrawElements(batch.upsert as never, { regenerateIds: false }))
        const idx = indexOf()
        for (const el of converted) {
          const at = idx.get(el.id)
          if (at === undefined) idx.set(el.id, next.push(el) - 1)
          else next[at] = bumped(next[at], { ...el, index: next[at].index, isDeleted: false })
          result.upserted.push(el.id)
        }
        removeOrphanedLabels(next, converted)
      }

      // 3. Property patches (e.g. dimming). Bound labels follow a moved container.
      if (batch.patch.length) {
        const byId = new Map(batch.patch.map((p) => [p.id, p.changes]))
        const shift = new Map<string, { dx: number; dy: number }>()
        next.forEach((e, i) => {
          const changes = byId.get(e.id)
          if (!changes || e.isDeleted) return
          const { id: _id, type: _type, version: _v, versionNonce: _n, ...safe } = changes
          const dx = typeof safe.x === 'number' ? safe.x - e.x : 0
          const dy = typeof safe.y === 'number' ? safe.y - e.y : 0
          if (dx || dy) for (const b of e.boundElements ?? []) if (b.type === 'text') shift.set(b.id, { dx, dy })
          next[i] = bumped(e, safe as Partial<ExcalidrawElement>)
          result.patched.push(e.id)
        })
        next.forEach((e, i) => {
          const s = shift.get(e.id)
          if (s && !byId.has(e.id)) next[i] = bumped(e, { x: e.x + s.dx, y: e.y + s.dy })
        })
      }

      // 4. Arrow bindings, so arrows follow their shapes when the user drags them.
      if (batch.bindings.length) {
        const idx = indexOf()
        const bind = (arrowId: string, targetId: string | undefined, side: 'startBinding' | 'endBinding'): void => {
          const ai = idx.get(arrowId)
          if (ai === undefined || !targetId) return
          const ti = idx.get(targetId)
          if (ti === undefined) return
          next[ai] = bumped(next[ai], { [side]: { elementId: targetId, focus: 0, gap: 4 } } as Partial<ExcalidrawElement>)
          const target = next[ti]
          const bound = target.boundElements ?? []
          if (!bound.some((b) => b.id === arrowId)) {
            next[ti] = bumped(target, { boundElements: [...bound, { id: arrowId, type: 'arrow' }] })
          }
        }
        for (const b of batch.bindings) {
          bind(b.arrowId, b.startId, 'startBinding')
          bind(b.arrowId, b.endId, 'endBinding')
        }
      }

      commit(next)

      // 5. Camera: animate to the new content (the only place the viewport changes).
      if (batch.focus?.ids.length) {
        const ids = new Set(batch.focus.ids)
        const targets = next.filter((e) => ids.has(e.id) && !e.isDeleted)
        if (targets.length) {
          const st = api.getAppState()
          const xs = targets.flatMap((e) => [e.x, e.x + e.width])
          const ys = targets.flatMap((e) => [e.y, e.y + e.height])
          const w = (Math.max(...xs) - Math.min(...xs)) * st.zoom.value
          const h = (Math.max(...ys) - Math.min(...ys)) * st.zoom.value
          const fits = !batch.focus.fit && w <= st.width * 0.85 && h <= st.height * 0.7
          // Content that fits is only panned into view (the learner's zoom is respected); only oversized
          // content is zoomed OUT to fit, and never zoomed in.
          api.scrollToContent(
            targets,
            fits
              ? { animate: true, duration: 450 }
              : { fitToViewport: true, viewportZoomFactor: 0.8, animate: true, duration: 450, maxZoom: Math.min(st.zoom.value, 1) }
          )
        }
      }
      return result
    }
  }
}

/**
 * Excalidraw keeps a default 100x0 width/height on freshly converted lines and arrows even though they are drawn
 * from their points. Anything that reasons about bounds (highlight rings, free-space search, hit areas) needs the
 * real extent, so derive it from the points.
 */
function normalizeLinearBounds(elements: ExcalidrawElement[]): ExcalidrawElement[] {
  return elements.map((el) => {
    if ((el.type !== 'line' && el.type !== 'arrow') || !Array.isArray((el as { points?: unknown }).points)) return el
    const pts = (el as unknown as { points: Array<[number, number]> }).points
    if (!pts.length) return el
    const xs = pts.map((p) => p[0])
    const ys = pts.map((p) => p[1])
    return { ...el, width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) } as ExcalidrawElement
  })
}

/** When a container is replaced, its previous bound text elements must not linger as duplicates. */
function removeOrphanedLabels(scene: ExcalidrawElement[], replaced: readonly ExcalidrawElement[]): void {
  const keep = new Set<string>()
  for (const el of replaced) {
    keep.add(el.id)
    for (const b of el.boundElements ?? []) keep.add(b.id)
  }
  const containerIds = new Set(replaced.map((e) => e.id))
  scene.forEach((e, i) => {
    if (e.type === 'text' && e.containerId && containerIds.has(e.containerId) && !keep.has(e.id) && !e.isDeleted) {
      scene[i] = bumped(e, { isDeleted: true })
    }
  })
}
