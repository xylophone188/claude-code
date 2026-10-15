/**
 * Redis-backed hot read cache for Session Memory.
 *
 * Session memory markdown is written by `extractSessionMemory` via the Edit
 * tool. In long-lived processes the disk read adds measurable latency on
 * every prompt build. A best-effort Redis copy lets hot sessions read from
 * an in-memory peer instead of the disk.
 *
 * Semantics:
 *   - Redis is a *mirror* — never authoritative. Disk remains source of
 *     truth; a Redis miss falls back to reading the file.
 *   - TTL is short (30s) so a stale cache is bounded to half a minute.
 *   - Write path calls `invalidateSessionMemoryCache()` to clear the entry
 *     immediately after extraction. This is fire-and-forget and never
 *     blocks the caller.
 *   - Opt-out: `CCB_SESSION_MEMORY_CACHE_ENABLED=0`.
 *   - Every Redis call is wrapped in try/catch: unavailable Redis must
 *     NEVER throw or reject.
 */
import { createHash } from 'crypto'
import { readFile } from 'fs/promises'
import { getSessionMemoryPath } from '../../utils/permissions/filesystem.js'
import { logError } from '../../utils/log.js'
import { errorMessage } from '../../utils/errors.js'
import { redisDel, redisGet, redisSet } from '../redis/client.js'

const CACHE_TTL_SECONDS = 30
const CACHE_KEY_PREFIX = 'ccb:sm:mem:v1:'

function isCacheEnabled(): boolean {
  return process.env.CCB_SESSION_MEMORY_CACHE_ENABLED !== '0'
}

function cacheKey(): string {
  const h = createHash('sha256')
    .update(getSessionMemoryPath())
    .digest('hex')
    .slice(0, 16)
  return CACHE_KEY_PREFIX + h
}

/**
 * Best-effort read from Redis. Returns null on miss or Redis failure.
 */
export async function getSessionMemoryFromRedis(): Promise<string | null> {
  if (!isCacheEnabled()) return null
  try {
    const val = await redisGet(cacheKey())
    return val && val.length > 0 ? val : null
  } catch (error) {
    logError(new Error('session memory cache read: ' + errorMessage(error)))
    return null
  }
}

/**
 * Read session memory from disk. Pure fallback — no Redis involved.
 */
export async function getSessionMemoryContentFromDisk(): Promise<
  string | null
> {
  try {
    return await readFile(getSessionMemoryPath(), { encoding: 'utf-8' })
  } catch {
    return null
  }
}

/**
 * Cache-aside read: try Redis first, fall back to disk + backfill.
 * Returns null only when both sources are empty/unavailable.
 */
export async function getSessionMemoryCached(): Promise<string | null> {
  const cached = await getSessionMemoryFromRedis()
  if (cached !== null) return cached
  const fromDisk = await getSessionMemoryContentFromDisk()
  if (fromDisk !== null && fromDisk.length > 0 && isCacheEnabled()) {
    void redisSet(cacheKey(), fromDisk, CACHE_TTL_SECONDS).catch(error => {
      logError(
        new Error('session memory cache backfill: ' + errorMessage(error)),
      )
    })
  }
  return fromDisk
}

/**
 * Fire-and-forget cache invalidation. Called after SessionMemory writes a
 * new summary to disk so subsequent reads don't serve the pre-extraction
 * content.
 */
export function invalidateSessionMemoryCache(): void {
  if (!isCacheEnabled()) return
  void redisDel(cacheKey()).catch(error => {
    logError(
      new Error('session memory cache invalidate: ' + errorMessage(error)),
    )
  })
}
