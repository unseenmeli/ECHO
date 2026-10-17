import { Redis } from '@upstash/redis'
import { MemoryStore, type CounterStore } from './counters'

class RedisStore implements CounterStore {
  readonly kind = 'redis'
  constructor(private readonly redis: Redis) {}

  async incr(key: string, by: number, ttlSeconds: number): Promise<number> {
    const [value] = await this.redis.pipeline().incrby(key, by).expire(key, ttlSeconds, 'NX').exec<[number, number]>()
    return value
  }

  async get(keys: string[]): Promise<number[]> {
    if (!keys.length) return []
    const values = await this.redis.mget<Array<number | string | null>>(...keys)
    return values.map((v) => Number(v ?? 0) || 0)
  }
}

let store: CounterStore | null | undefined

/**
 * Upstash Redis (from the Vercel Marketplace) when it is connected. Without it, production refuses to run rather
 * than enforce limits per instance; set ECHO_ALLOW_MEMORY_LIMITS=1 to accept that anyway.
 */
export function counterStore(): CounterStore | null {
  if (store !== undefined) return store
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL
  const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN
  if (url && token) store = new RedisStore(new Redis({ url, token }))
  else if (process.env.VERCEL_ENV === 'production' && process.env.ECHO_ALLOW_MEMORY_LIMITS !== '1') store = null
  else store = new MemoryStore()
  return store
}
