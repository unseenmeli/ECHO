import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import {
  PREFERENCE_DEFS,
  PREFERENCE_KEYS,
  validatePreference,
  type PreferenceEntry,
  type PreferenceKey,
  type PreferenceMap,
  type PreferenceSource,
  type PreferencesView,
  type PreferenceToast
} from '../../shared/preferences'

const FILE_VERSION = 1

/** Where the preferences live. Swapped for an in-memory double in tests. */
export interface PreferenceFileIo {
  read(file: string): string | null
  write(file: string, data: string): void
}

export const nodeFileIo: PreferenceFileIo = {
  read(file) {
    try {
      return readFileSync(file, 'utf8')
    } catch {
      return null
    }
  },
  write(file, data) {
    mkdirSync(dirname(file), { recursive: true })
    // Write beside the target and rename, so a crash mid-write never leaves a half-written file.
    const tmp = `${file}.tmp`
    writeFileSync(tmp, data, 'utf8')
    renameSync(tmp, file)
  }
}

export type SetResult =
  | { ok: true; value: string; changed: boolean; previous?: string }
  | { ok: false; reason: string }

export interface StoreChange {
  view: PreferencesView
  /** A new "Preference saved · Undo" announcement, or null to dismiss the current one. Absent: leave it as is. */
  toast?: PreferenceToast | null
}

export interface SetOptions {
  /** Announce with a toast. Off for edits made in the settings window, where the change is already visible. */
  announce?: boolean
}

/** What the voice session and the agent tools need from the store. */
export interface PreferenceStorePort {
  get(key: PreferenceKey): string | undefined
  set(key: PreferenceKey, raw: unknown, source: PreferenceSource, options?: SetOptions): SetResult
  forget(key: PreferenceKey, options?: SetOptions): boolean
  forgetAll(options?: SetOptions): number
  /** Saved preferences as text for the system prompt, or '' when there are none. */
  promptBlock(): string
}

/**
 * Persistent, structured user preferences: one value per key, kept in a small JSON file. Setting a key that
 * already has a value replaces it, so conflicting entries cannot accumulate.
 */
export class PreferenceStore implements PreferenceStorePort {
  private map: PreferenceMap = {}
  private listeners = new Set<(change: StoreChange) => void>()
  private toastSeq = 0
  /** State before the last announced change, so Undo can put it back. */
  private undoState: { id: number; before: PreferenceMap } | null = null

  constructor(
    private readonly file: string,
    private readonly io: PreferenceFileIo = nodeFileIo,
    private readonly now: () => number = Date.now
  ) {
    this.map = this.load()
  }

  // --- Reading -----------------------------------------------------------------------------

  get(key: PreferenceKey): string | undefined {
    return this.map[key]?.value
  }

  entries(): PreferenceMap {
    return { ...this.map }
  }

  view(): PreferencesView {
    return {
      rows: PREFERENCE_DEFS.map((d) => ({
        key: d.key,
        label: d.label,
        hint: d.hint,
        options: d.options,
        maxLength: d.maxLength,
        entry: this.map[d.key] ? { ...this.map[d.key]! } : null
      }))
    }
  }

  promptBlock(): string {
    const lines = PREFERENCE_DEFS.flatMap((d) => {
      const e = this.map[d.key]
      if (!e) return []
      // "Your name" is ambiguous in a prompt addressed to ECHO. Make the subject explicit so
      // the model applies this to the learner rather than treating it as its own name.
      const label = d.key === 'userName' ? "The learner's name (the person you are speaking with; your name is ECHO)" : d.label
      return [`- ${label}: ${e.value}`]
    })
    return lines.length ? lines.join('\n') : ''
  }

  subscribe(listener: (change: StoreChange) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  // --- Writing -----------------------------------------------------------------------------

  set(key: PreferenceKey, raw: unknown, source: PreferenceSource, options: SetOptions = {}): SetResult {
    const checked = validatePreference(key, raw)
    if (!checked.ok) return checked
    const previous = this.map[key]?.value
    if (previous === checked.value) return { ok: true, value: checked.value, changed: false, previous }
    const before = { ...this.map }
    this.map = { ...this.map, [key]: { value: checked.value, updatedAt: this.now(), source } }
    this.commit(before, 'Preference saved', options)
    return { ok: true, value: checked.value, changed: true, previous }
  }

  forget(key: PreferenceKey, options: SetOptions = {}): boolean {
    if (!this.map[key]) return false
    const before = { ...this.map }
    const { [key]: _removed, ...rest } = this.map
    this.map = rest
    this.commit(before, 'Preference forgotten', options)
    return true
  }

  forgetAll(options: SetOptions = {}): number {
    const count = Object.keys(this.map).length
    if (!count) return 0
    const before = { ...this.map }
    this.map = {}
    this.commit(before, 'Preferences forgotten', options)
    return count
  }

  /** Reverts the change announced by toast `id`. False when that change is no longer the latest. */
  undo(id: number): boolean {
    const u = this.undoState
    if (!u || u.id !== id) return false
    this.undoState = null
    this.map = u.before
    this.save()
    this.emit({ view: this.view(), toast: null })
    return true
  }

  // --- Internals ---------------------------------------------------------------------------

  private commit(before: PreferenceMap, message: string, options: SetOptions): void {
    this.save()
    if (options.announce === false) {
      // An unannounced edit leaves nothing to undo, and makes any earlier Undo stale.
      this.undoState = null
      this.emit({ view: this.view(), toast: null })
      return
    }
    const id = ++this.toastSeq
    this.undoState = { id, before }
    this.emit({ view: this.view(), toast: { id, message } })
  }

  private emit(change: StoreChange): void {
    for (const l of this.listeners) l(change)
  }

  private load(): PreferenceMap {
    const text = this.io.read(this.file)
    if (!text) return {}
    try {
      const parsed = JSON.parse(text) as { version?: number; preferences?: Record<string, Partial<PreferenceEntry>> }
      const out: PreferenceMap = {}
      for (const key of PREFERENCE_KEYS) {
        const e = parsed.preferences?.[key]
        if (!e) continue
        // The file is edited by hand sometimes: hold its values to the same rules as a live write.
        const checked = validatePreference(key, e.value)
        if (!checked.ok) continue
        const source: PreferenceSource = e.source === 'confirmed' || e.source === 'user' ? e.source : 'explicit'
        out[key] = { value: checked.value, updatedAt: typeof e.updatedAt === 'number' ? e.updatedAt : 0, source }
      }
      return out
    } catch {
      return {}
    }
  }

  private save(): void {
    try {
      this.io.write(this.file, JSON.stringify({ version: FILE_VERSION, preferences: this.map }, null, 2))
    } catch (err) {
      // Not being able to persist must not break the conversation; the value still applies this session.
      console.log(`[preferences] could not save: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}
