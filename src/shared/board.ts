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
}

export type BoardMethod = keyof BoardApi

/** What survives closing the tutoring window (kept in the main process). */
export interface SavedBoard {
  elements: BoardElement[]
  viewport: BoardViewport
}
