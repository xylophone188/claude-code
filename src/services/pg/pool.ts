/**
 * PostgreSQL connection pool for the OmniRoute authoritative store.
 *
 * DSN resolution:
 *   1. PG_DSN / OMNIROUTE_DSN / DATABASE_URL env var (highest precedence)
 *   2. Explicit host/port/user/password/db/envs
 *   3. Hard-coded localhost defaults matching the shipped omniroute schema
 *
 * Never logs credentials. Errors are structured so callers can decide whether
 * to fail fast (loader) or degrade gracefully (scoring).
 */

import { Pool, type PoolClient, type PoolConfig } from 'pg'

export type { PoolClient }

export const PG_DEFAULTS = {
  host: '127.0.0.1',
  port: 5432,
  user: 'omniroute',
  database: 'omniroute',
  searchPath: 'omniroute,public',
} as const

export interface PgPoolOptions {
  dsn?: string
  host?: string
  port?: number
  user?: string
  password?: string
  database?: string
  schema?: string
  ssl?: boolean | object
  max?: number
  idleTimeoutMillis?: number
  connectionTimeoutMillis?: number
}

function resolveConfig(opts: PgPoolOptions): PoolConfig {
  const dsn =
    opts.dsn ??
    process.env.PG_DSN ??
    process.env.OMNIROUTE_DSN ??
    process.env.DATABASE_URL
  if (dsn) {
    const cfg: PoolConfig = { connectionString: dsn }
    const schema = opts.schema ?? PG_DEFAULTS.searchPath
    cfg.options = `-c search_path=${schema}`
    if (opts.ssl) cfg.ssl = opts.ssl
    if (opts.max) cfg.max = opts.max
    if (opts.connectionTimeoutMillis)
      cfg.connectionTimeoutMillis = opts.connectionTimeoutMillis
    return cfg
  }
  const config: PoolConfig = {
    host: opts.host ?? process.env.PG_HOST ?? PG_DEFAULTS.host,
    port: Number(process.env.PG_PORT ?? opts.port ?? PG_DEFAULTS.port),
    user: opts.user ?? process.env.PG_USER ?? PG_DEFAULTS.user,
    password:
      opts.password ??
      process.env.PG_PASSWORD ??
      process.env.OMNIROUTE_PG_PASSWORD,
    database: opts.database ?? process.env.PG_DATABASE ?? PG_DEFAULTS.database,
    options: `-c search_path=${opts.schema ?? PG_DEFAULTS.searchPath}`,
  }
  if (opts.ssl) config.ssl = opts.ssl
  if (opts.max) config.max = opts.max
  if (opts.idleTimeoutMillis) config.idleTimeoutMillis = opts.idleTimeoutMillis
  if (opts.connectionTimeoutMillis)
    config.connectionTimeoutMillis = opts.connectionTimeoutMillis
  return config
}

let pool: Pool | null = null
let poolPromise: Promise<Pool> | null = null

export function getPgPool(opts: PgPoolOptions = {}): Pool {
  if (pool) return pool
  const cfg = resolveConfig(opts)
  pool = new Pool({
    ...cfg,
    connectionTimeoutMillis: cfg.connectionTimeoutMillis ?? 3000,
    max: cfg.max ?? 8,
  })
  pool.on('error', err => {
    try {
      // eslint-disable-next-line no-console
      console.error('[pg:pool] idle error:', err.message)
    } catch {}
  })
  return pool
}

export function getOrCreatePool(opts: PgPoolOptions = {}): Promise<Pool> {
  if (pool) return Promise.resolve(pool)
  if (poolPromise) return poolPromise
  poolPromise = Promise.resolve(getPgPool(opts))
  return poolPromise
}

/**
 * Execute a query with a bounded retry on transient connection errors.
 * Non-transient errors (syntax, constraint) bubble immediately.
 */
export async function pgQuery<
  T extends Record<string, unknown> = Record<string, unknown>,
>(text: string, params: unknown[] = [], retries = 2): Promise<T[]> {
  const p = await getOrCreatePool()
  let lastErr: unknown
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await p.query<T>(text, params)
      return res.rows
    } catch (err: unknown) {
      lastErr = err
      const msg = err instanceof Error ? err.message : String(err)
      const transient =
        /ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|timeout|terminating connection/i.test(
          msg,
        )
      if (!transient || i === retries) throw err
      await new Promise(r => setTimeout(r, 50 * (i + 1)))
    }
  }
  throw lastErr
}

export async function pgQueryOne<
  T extends Record<string, unknown> = Record<string, unknown>,
>(text: string, params: unknown[] = []): Promise<T | null> {
  const rows = await pgQuery<T>(text, params)
  return rows[0] ?? null
}

export async function pgExecute(
  text: string,
  params: unknown[] = [],
): Promise<void> {
  const p = await getOrCreatePool()
  await p.query(text, params)
}

/**
 * Executes a callback within a managed PostgreSQL transaction.
 * Issues BEGIN before the callback, COMMIT on success, ROLLBACK on failure,
 * and guarantees the client is released back to the pool in finally.
 */
export async function withPgTransaction<T>(
  callback: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const p = await getOrCreatePool()
  const client = await p.connect()
  try {
    await client.query('BEGIN')
    const result = await callback(client)
    await client.query('COMMIT')
    return result
  } catch (err) {
    try {
      await client.query('ROLLBACK')
    } catch {
      // Preserve original error if ROLLBACK fails
    }
    throw err
  } finally {
    client.release()
  }
}

export async function pgIsAvailable(): Promise<boolean> {
  try {
    const rows = await pgQuery<{ v: number }>('SELECT 1 AS v')
    return rows[0]?.v === 1
  } catch {
    return false
  }
}

export async function closePgPool(): Promise<void> {
  if (!pool) return
  const p = pool
  pool = null
  poolPromise = null
  await p.end()
}

export function resetPgPool(): void {
  pool = null
  poolPromise = null
}
