/**
 * Redis client for high-frequency runtime state: dynamic latency scores,
 * 429 cooldown windows, real-time rate-limit counters, hot model caches,
 * and provider health heartbeats.
 *
 * All keys are namespaced under `ccb:runtime:v1:` to avoid colliding with
 * any other Redis consumer on the shared instance.
 *
 * Every read/write helper is fault-tolerant: an unreachable Redis never
 * breaks the calling pipeline. The pool loader and scorer degrade to
 * "no dynamic signal" when the client is down.
 */

import Redis, { type RedisOptions } from 'ioredis'

export const REDIS_DEFAULTS = {
  host: '127.0.0.1',
  port: 6379,
  password: 'melody_redis_2026',
} as const

export const REDIS_KEY_PREFIX = 'ccb:runtime:v1:'

export interface RedisClientOptions {
  host?: string
  port?: number
  password?: string
  db?: number
}

let client: Redis | null = null
let configuredPrefix = REDIS_KEY_PREFIX

/**
 * ioredis's `prefix` RedisOption is not typed as a known field in the current
 * build — pass it through a plain-object cast so the runtime still picks it up.
 */
function resolveRedisOptions(opts: RedisClientOptions): unknown {
  return {
    host: opts.host ?? process.env.REDIS_HOST ?? REDIS_DEFAULTS.host,
    port: Number(process.env.REDIS_PORT ?? opts.port ?? REDIS_DEFAULTS.port),
    password:
      opts.password ??
      process.env.REDIS_PASSWORD ??
      process.env.OMNIROUTE_REDIS_PASSWORD ??
      REDIS_DEFAULTS.password,
    db: opts.db ?? 0,
    prefix: configuredPrefix,
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 2000,
    commandTimeout: 2000,
    retryStrategy: (times: number): number | null =>
      times > 3 ? null : Math.min(times * 200, 2000),
    tls: process.env.REDIS_TLS === '1' ? {} : undefined,
  }
}

export function getRedisClient(opts: RedisClientOptions = {}): Redis {
  if (client) return client
  const c = new Redis(resolveRedisOptions(opts) as RedisOptions)
  c.on('error', () => {
    // Silenced: transient connection errors are expected and swallowed
    // by the caller. Logging every retry floods the console in offline
    // environments (mobile Termux etc.).
  })
  client = c
  return c
}

async function ensureConnected(): Promise<boolean> {
  const c = getRedisClient()
  if (c.status === 'wait') {
    try {
      await c.connect()
    } catch {
      return false
    }
  }
  return c.status === 'ready'
}

/** Best-effort connection check. Never throws. */
export async function redisIsAvailable(): Promise<boolean> {
  try {
    const c = getRedisClient()
    if (c.status === 'wait') await c.connect()
    const ok = await c.ping()
    return ok === 'PONG'
  } catch {
    return false
  }
}

export async function redisGet(key: string): Promise<string | null> {
  try {
    if (!(await ensureConnected())) return null
    return await getRedisClient().get(key)
  } catch {
    return null
  }
}

export async function redisSet(
  key: string,
  value: string,
  ttlSeconds?: number,
): Promise<boolean> {
  try {
    if (!(await ensureConnected())) return false
    const c = getRedisClient()
    if (ttlSeconds && ttlSeconds > 0) await c.set(key, value, 'EX', ttlSeconds)
    else await c.set(key, value)
    return true
  } catch {
    return false
  }
}

export async function redisDel(key: string): Promise<void> {
  try {
    if (!(await ensureConnected())) return
    await getRedisClient().del(key)
  } catch {
    /* swallow */
  }
}

export async function redisIncr(
  key: string,
  ttlSeconds?: number,
): Promise<number | null> {
  try {
    if (!(await ensureConnected())) return null
    const c = getRedisClient()
    const n = await c.incr(key)
    if (ttlSeconds && ttlSeconds > 0) await c.expire(key, ttlSeconds)
    return n
  } catch {
    return null
  }
}

export async function redisExpire(key: string, ttlSeconds: number): Promise<void> {
  try {
    if (!(await ensureConnected())) return
    await getRedisClient().expire(key, ttlSeconds)
  } catch {
    /* swallow */
  }
}

/**
 * Pipeline helper for multi-key reads/writes. `ops` is a list of
 * `[method, ...args]` tuples where method names match the ioredis client
 * API (`set`, `del`, `incr`, `expire`, `get`, `mset`, `ttl`, `exists`).
 * Unknown methods are skipped. Returns a result array parallel to `ops`
 * — non-command positions are null, `get`/`incr`/`ttl`/`exists`/`del`
 * entries return their value, `set`/`expire` return true on success.
 */
export async function redisPipelineResults(
  ops: Array<[string, ...unknown[]]>,
): Promise<Array<unknown>> {
  if (!ops.length) return []
  try {
    if (!(await ensureConnected())) return ops.map(() => null)
    const c = getRedisClient()
    const pipe = c.pipeline()
    for (const op of ops) {
      const [cmd, ...args] = op
      const callable = (pipe as unknown as Record<string, unknown>)[cmd]
      if (typeof callable === 'function') {
        (callable as (...a: unknown[]) => void)(...(args as []))
      }
    }
    const execResult = await pipe.exec()
    if (!execResult) return ops.map(() => null)
    return execResult.map(entry => (entry ? entry[1] : null))
  } catch {
    return ops.map(() => null)
  }
}

export async function redisPipelined(
  ops: Array<[string, ...unknown[]]>,
): Promise<boolean> {
  const results = await redisPipelineResults(ops)
  return results.length === ops.length
}

export async function closeRedisClient(): Promise<void> {
  if (!client) return
  const c = client
  client = null
  try {
    await c.quit()
  } catch {
    c.disconnect()
  }
}

export function resetRedisClient(): void {
  client = null
}
