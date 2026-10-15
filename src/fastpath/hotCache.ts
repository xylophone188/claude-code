// Redis 热点缓存 — pipeline 三段结果缓存（embed 向量 / PG 召回 / 最终产物）
// 零新依赖：ioredis 已在 package.json。Redis 不可用时全部降级为 no-op。
import { createHash } from 'node:crypto'

const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379/0'
export const TTL_EMBED = 86400 // 24h
export const TTL_CANDIDATES = 3600 // 1h
export const TTL_RESULT = 3600 // 1h

let clientPromise: Promise<any> | null = null

function getClient(): Promise<any> | null {
  if (!clientPromise) {
    clientPromise = (async () => {
      try {
        const { default: Redis } = await import('ioredis')
        const c = new Redis(REDIS_URL, {
          lazyConnect: true,
          connectTimeout: 1500,
          commandTimeout: 1000,
          maxRetriesPerRequest: 0,
          retryStrategy: () => null,
        })
        return await c
          .connect()
          .then(() => c)
          .catch(() => null)
      } catch {
        return null
      }
    })()
  }
  return clientPromise
}

export function cacheKey(prefix: string, input: string): string {
  return `ccb:pipeline:${prefix}:${createHash('sha256').update(input).digest('hex').slice(0, 32)}`
}

export async function cacheGet<T>(key: string): Promise<T | null> {
  try {
    const c = await getClient()
    if (!c) return null
    const v = await c.get(key)
    return v ? (JSON.parse(v) as T) : null
  } catch {
    return null
  }
}

export async function cacheSet(
  key: string,
  value: unknown,
  ttl: number,
): Promise<void> {
  try {
    const c = await getClient()
    if (!c) return
    await c.set(key, JSON.stringify(value), 'EX', ttl)
  } catch {
    /* cache miss is fine */
  }
}
