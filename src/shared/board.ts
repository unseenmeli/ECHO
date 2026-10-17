// Contract for the shared tutoring whiteboard. The renderer implements it
// against Excalidraw; the main process calls it (see src/main/board.ts) so
// future Claude actions and user edits operate on the same scene.

/** A serialized Excalidraw element. Always carries a stable `id`. */
export interface BoardElement {
  id: string
  type: string
  x: number
  y: number
  width: number
  height: number
  [key: string]: unknown
}

/**
 * Excalidraw "element skeleton" (https://docs.excalidraw.com/docs/@excalidraw/excalidraw/api/excalidraw-element-skeleton).
 * Pass an `id` to create-or-replace an element with a stable identity.
 */
export interface ElementSkeleton {
  id: string
  type: string
  x: number
  y: number
  [key: string]: unknown
}

export interface BoardViewport {
  scrollX: number
  scrollY: number
  zoom: number
  /** Size of the visible canvas in screen pixels (set by getScene; absent in saved boards). */
  width?: number
  height?: number
}

export interface BoardScene {
  elements: BoardElement[]
  viewport: BoardViewport
}

/** Properties that can never be patched through `updateElements`. */
export type ElementPatch = { id: string; changes: Record<string, unknown> }

export interface BoardApi {
  /** All live (non-deleted) elements plus the current camera. */
  getScene(): Promise<BoardScene>
  /** Elements the user currently has selected. */
  getSelected(): Promise<BoardElement[]>
  /** Create elements, or replace existing ones that share an id. Returns every resulting element id. */
  upsertElements(skeletons: ElementSkeleton[]): Promise<string[]>
  /** Shallow-merge changes into existing elements. Returns the ids that were found and updated. */
  updateElements(patches: ElementPatch[]): Promise<string[]>
  /** Delete elements by id. Returns the ids that were found and deleted. */
  deleteElements(ids: string[]): Promise<string[]>
  clear(): Promise<void>
  /** Apply a validated batch atomically. */
  applyBatch(batch: BoardBatch): Promise<BatchResult>
}

/** Makes `arrowId` follow the shapes at its ends when the user drags them. */
export interface BindingSpec {
  arrowId: string
  startId?: string
  endId?: string
}

/**
 * Several related changes applied as ONE atomic scene update, so a diagram
 * appears (or a highlight moves) in a single frame and is one undo step.
 * Untouched elements, the user's drawings and the camera are left alone.
 */
export interface BoardBatch {
  upsert: ElementSkeleton[]
  patch: ElementPatch[]
  remove: string[]
  bindings: BindingSpec[]
  /**
   * Animate the camera to these elements. "frame" centres and sizes the view around newly drawn content;
   * "pan" glides to what the narration is about without changing the zoom unless it doesn't fit.
   */
  focus?: {
    ids: string[]
    mode?: 'frame' | 'pan'
    /** What the focused elements belong to (e.g. their diagram): kept in view while panning when it fits. */
    context?: string[]
    /** The content is larger than the free area: zoom out so all of it is visible. */
    fit?: boolean
  }
}

export interface BatchResult {
  upserted: string[]
  patched: string[]
  removed: string[]
}

export type BoardMethod = keyof BoardApi

/** What survives closing the tutoring window (kept in the main process). */
export interface SavedBoard {
  elements: BoardElement[]
  viewport: BoardViewport
}
