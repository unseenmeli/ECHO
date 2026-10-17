/** Counters that expire. Usage limits need them shared by every function instance, so production uses Redis. */
export interface CounterStore {
  readonly kind: 'redis' | 'memory'
  /** Adds `by` and returns the new value. The key expires `ttlSeconds` after its first write. */
  incr(key: string, by: number, ttlSeconds: number): Promise<number>
  get(keys: string[]): Promise<number[]>
}

/** Per-instance counters, for local development only. */
export class MemoryStore implements CounterStore {
  readonly kind = 'memory'
  private readonly map = new Map<string, { value: number; expires: number }>()

  constructor(private readonly now: () => number = Date.now) {}

  private live(key: string): { value: number; expires: number } | undefined {
    const e = this.map.get(key)
    if (e && e.expires <= this.now()) {
      this.map.delete(key)
      return undefined
    }
    return e
  }

  async incr(key: string, by: number, ttlSeconds: number): Promise<number> {
    const e = this.live(key) ?? { value: 0, expires: this.now() + ttlSeconds * 1000 }
    e.value += by
    this.map.set(key, e)
    return e.value
  }

  async get(keys: string[]): Promise<number[]> {
    return keys.map((k) => this.live(k)?.value ?? 0)
  }
}
