import { CaptureUpdateAction, convertToExcalidrawElements } from '@excalidraw/excalidraw'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types'
import type { BatchResult, BoardApi, BoardBatch, BoardElement, ElementPatch, ElementSkeleton } from '../../../shared/board'

const newNonce = (): number => Math.floor(Math.random() * 2 ** 31)

// Excalidraw sizes text when an element is created, but loads a font only once something uses it. Without
// this, the first lesson drawing is measured with a fallback font and its labels render clipped. (Called once
// Excalidraw is mounted, so its font faces are registered.)
let lessonFonts: Promise<unknown> | null = null
const lessonFontsReady = (): Promise<unknown> =>
  (lessonFonts ??= Promise.all(['18px Nunito', '26px "Lilita One"', '16px Cascadia'].map((f) => document.fonts.load(f, 'Aa').catch(() => []))))

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
  const camera = createCamera(api)
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
      if (batch.upsert.length) await lessonFontsReady()
      // Picture data first: image elements in this batch refer to it by fileId.
      if (batch.files?.length) {
        api.addFiles(batch.files.map((f) => ({ id: f.id, dataURL: f.dataURL, mimeType: f.mimeType, created: Date.now() })) as never)
      }
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

      // 5. Camera: glide to what the lesson is about (the only place the viewport changes).
      if (batch.focus?.ids.length) {
        const ids = new Set(batch.focus.ids)
        const targets = next.filter((e) => ids.has(e.id) && !e.isDeleted)
        const context = new Set(batch.focus.context ?? [])
        const around = context.size ? next.filter((e) => context.has(e.id) && !e.isDeleted) : []
        if (targets.length) camera.glideTo(targets, batch.focus.mode ?? 'frame', around)
      }
      return result
    }
  }
}

// Screen space covered by floating UI: title bar, toolbar and its hint above; the voice dock below.
const CAMERA_INSETS = { top: 132, bottom: 140, left: 56, right: 56 }
const MIN_ZOOM = 0.35
/** Below this, 18px labels get hard to read; the camera won't zoom out further just to show context. */
const MIN_READABLE_ZOOM = 0.6
/** Newly drawn content is framed at a comfortable size, but never blown up past this. */
const MAX_FRAME_ZOOM = 1.15
const GLIDE_MS = 700

/** True scene bounds: a line or arrow's x/y is its first point, and its points can run left or up from there. */
function sceneBounds(e: ExcalidrawElement): { x1: number; y1: number; x2: number; y2: number } {
  const pts = (e as { points?: ReadonlyArray<readonly [number, number]> }).points
  if (!pts?.length) return { x1: e.x, y1: e.y, x2: e.x + e.width, y2: e.y + e.height }
  const xs = pts.map((p) => e.x + p[0])
  const ys = pts.map((p) => e.y + p[1])
  return { x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys) }
}

const easeInOutCubic = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2)

/**
 * Guided-tour camera: centres content in the free part of the canvas with an eased glide. The scene point
 * under the view centre and the zoom are interpolated together, so the motion is a single smooth swoop.
 */
function createCamera(api: ExcalidrawImperativeAPI) {
  let frame = 0

  return {
    glideTo(targets: readonly ExcalidrawElement[], mode: 'frame' | 'pan', around: readonly ExcalidrawElement[] = []): void {
      const st = api.getAppState()
      const boxes = targets.map(sceneBounds)
      const minX = Math.min(...boxes.map((b) => b.x1))
      const minY = Math.min(...boxes.map((b) => b.y1))
      const maxX = Math.max(...boxes.map((b) => b.x2))
      const maxY = Math.max(...boxes.map((b) => b.y2))
      let cx = (minX + maxX) / 2
      let cy = (minY + maxY) / 2
      const availW = Math.max(200, st.width - CAMERA_INSETS.left - CAMERA_INSETS.right)
      const availH = Math.max(160, st.height - CAMERA_INSETS.top - CAMERA_INSETS.bottom)
      // Screen point the content should end up centred on.
      const sx = CAMERA_INSETS.left + availW / 2
      const sy = CAMERA_INSETS.top + availH / 2

      const z0: number = st.zoom.value
      const fitZoom = Math.min(availW / Math.max(1, maxX - minX), availH / Math.max(1, maxY - minY)) * 0.88
      let z1 = z0
      if (mode === 'frame') z1 = Math.max(MIN_ZOOM, Math.min(MAX_FRAME_ZOOM, fitZoom))
      else if (fitZoom < z0) z1 = Math.max(MIN_ZOOM, fitZoom) // too big to see at this zoom: back off

      // Follow the focus, but keep what it belongs to in view when that fits: a small diagram stays put while
      // its parts are highlighted, a large one scrolls along.
      if (around.length) {
        const ctx = around.map(sceneBounds)
        const box = { x1: Math.min(...ctx.map((b) => b.x1)), y1: Math.min(...ctx.map((b) => b.y1)), x2: Math.max(...ctx.map((b) => b.x2)), y2: Math.max(...ctx.map((b) => b.y2)) }
        // Slightly too big: back off a little so the whole diagram shows, while text stays readable.
        const ctxFit = Math.min(availW / (box.x2 - box.x1), availH / (box.y2 - box.y1)) * 0.92
        if (ctxFit < z1 && ctxFit >= MIN_READABLE_ZOOM) z1 = ctxFit
        const keep = (lo: number, hi: number, c: number, half: number): number =>
          hi - lo <= half * 2 ? Math.min(Math.max(c, hi - half), lo + half) : c
        cx = keep(box.x1, box.x2, cx, availW / 2 / z1)
        cy = keep(box.y1, box.y2, cy, availH / 2 / z1)
      }

      // Scene point currently under (sx, sy).
      const c0 = { x: sx / z0 - st.scrollX, y: sy / z0 - st.scrollY }
      // Already centred enough that moving would just be jitter.
      const dx = Math.abs(c0.x - cx) * z0
      const dy = Math.abs(c0.y - cy) * z0
      if (mode === 'pan' && z1 === z0 && dx < availW * 0.12 && dy < availH * 0.12) return

      cancelAnimationFrame(frame)
      const start = performance.now()
      const step = (now: number): void => {
        const t = Math.min(1, (now - start) / GLIDE_MS)
        const k = easeInOutCubic(t)
        // Zoom is interpolated geometrically so zooming in and out feel equally fast.
        const z = z0 * (z1 / z0) ** k
        const x = c0.x + (cx - c0.x) * k
        const y = c0.y + (cy - c0.y) * k
        api.updateScene({
          appState: { scrollX: sx / z - x, scrollY: sy / z - y, zoom: { value: z as never } },
          captureUpdate: CaptureUpdateAction.NEVER
        })
        if (t < 1) frame = requestAnimationFrame(step)
      }
      frame = requestAnimationFrame(step)
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
