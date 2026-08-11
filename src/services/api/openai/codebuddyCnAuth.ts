/**
 * codebuddyCnAuth.ts
 *
 * Account pool + login for **CodeBuddy CN** (Tencent) providers, modeled on
 * chatgptAuth.ts but adapted to CodeBuddy's plaintext-token storage and
 * Tencent device-flow OAuth.
 *
 * Resources aggregated into this pool come from two sources:
 *   1. `/ccb import-9router <storage.sqlite>` — one-time, read-only migration of
 *      the 9router local SQLite DB (providerConnections where provider='codebuddy-cn'
 *      AND isActive=1). The source DB is opened read-only; runtime never consults it.
 *   2. Interactive device-flow login (`requestCodeBuddyCnDeviceCode` / `pollCodeBuddyCnToken`).
 *
 * The pool is ADD-only (merge by accountId) — importing never deletes or disables
 * an existing account, so a re-import or a second source can only add/refresh.
 */
import { chmod, mkdir, readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { getClaudeConfigHomeDir } from '../../../utils/envUtils.js'
import { routeLog, routeError } from '../../routing/stageLog.js'

const AUTH_FILE = 'codebuddy-cn-auth.json'

export interface CodeBuddyCnAuthTokens {
  /** Stable id — for 9router imports this is the connection UUID. */
  accountId: string
  accessToken: string
  refreshToken: string
  /** ISO timestamp when the access token expires, if known. */
  expiresAt?: string
  lastRefresh?: string
}

type StoredCnPoolFile = {
  accounts: CodeBuddyCnAuthTokens[]
}

type Cn9RouterConnectionRow = {
  id: string
  data: string
}

function authFilePath(): string {
  return join(getClaudeConfigHomeDir(), AUTH_FILE)
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

async function readStoredCnPool(): Promise<CodeBuddyCnAuthTokens[]> {
  try {
    const raw = await readFile(authFilePath(), 'utf8')
    const parsed = JSON.parse(raw) as StoredCnPoolFile
    if (!parsed || !Array.isArray(parsed.accounts)) return []
    return parsed.accounts.filter(
      (a): a is CodeBuddyCnAuthTokens =>
        !!a &&
        typeof a.accountId === 'string' &&
        typeof a.accessToken === 'string' &&
        typeof a.refreshToken === 'string',
    )
  } catch {
    return []
  }
}

async function saveStoredCnPool(
  accounts: CodeBuddyCnAuthTokens[],
): Promise<void> {
  const path = authFilePath()
  await mkdir(getClaudeConfigHomeDir(), { recursive: true })
  const body: StoredCnPoolFile = { accounts }
  await writeFile(path, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 })
  await chmod(path, 0o600).catch(() => undefined)
}

/**
 * Merge imported tokens into the pool, keyed by accountId. Existing accounts are
 * refreshed in place; new accounts are appended. Never removes an account.
 */
export async function mergeStoredCnPool(
  imported: CodeBuddyCnAuthTokens[],
): Promise<void> {
  const existing = await readStoredCnPool()
  const byId = new Map(existing.map(a => [a.accountId, a]))
  for (const tokens of imported) byId.set(tokens.accountId, tokens)
  await saveStoredCnPool([...byId.values()])
}

/**
 * One-time migration from 9router's local SQLite DB. Read-only on the source.
 * Returns the number of accounts imported.
 */
export async function importCodeBuddyCnFrom9Router(
  databasePath: string,
): Promise<number> {
  const query = `SELECT id, data FROM providerConnections
    WHERE provider = 'codebuddy-cn' AND isActive = 1`
  const rows: Cn9RouterConnectionRow[] =
    typeof Bun !== 'undefined'
      ? await (async () => {
          const { Database } = await import('bun:sqlite')
          const database = new Database(databasePath, { readonly: true })
          try {
            return database.query<Cn9RouterConnectionRow, []>(query).all()
          } finally {
            database.close()
          }
        })()
      : []
  const imported: CodeBuddyCnAuthTokens[] = []
  for (const row of rows) {
    const tokens = tokensFrom9RouterRow(row)
    if (tokens) imported.push(tokens)
  }
  if (imported.length) await mergeStoredCnPool(imported)
  routeLog(
    'cn',
    `import-9router: ${imported.length}/${rows.length} codebuddy-cn accounts merged`,
  )
  return imported.length
}

function tokensFrom9RouterRow(
  row: Cn9RouterConnectionRow,
): CodeBuddyCnAuthTokens | null {
  let data: Record<string, unknown> | null = null
  try {
    data = JSON.parse(row.data) as Record<string, unknown>
  } catch {
    return null
  }
  if (!data) return null
  const accessToken = asString(data.accessToken)
  const refreshToken = asString(data.refreshToken)
  if (!accessToken || !refreshToken) return null
  return {
    accountId: row.id,
    accessToken,
    refreshToken,
    ...(asString(data.expiresAt)
      ? { expiresAt: asString(data.expiresAt) }
      : {}),
    lastRefresh: new Date().toISOString(),
  }
}

export async function hasCodeBuddyCnAccountPool(): Promise<boolean> {
  return (await readStoredCnPool()).length > 0
}

/** Read the raw pool (used by the provider loader to inject accounts). */
export async function readCodeBuddyCnPool(): Promise<CodeBuddyCnAuthTokens[]> {
  return readStoredCnPool()
}

/** Synchronous variant for the (sync) provider loader. */
export function readCodeBuddyCnPoolSync(): CodeBuddyCnAuthTokens[] {
  try {
    const { readFileSync } = require('fs') as typeof import('fs')
    const raw = readFileSync(authFilePath(), 'utf8')
    const parsed = JSON.parse(raw) as StoredCnPoolFile
    if (!parsed || !Array.isArray(parsed.accounts)) return []
    return parsed.accounts.filter(
      (a): a is CodeBuddyCnAuthTokens =>
        !!a &&
        typeof a.accountId === 'string' &&
        typeof a.accessToken === 'string' &&
        typeof a.refreshToken === 'string',
    )
  } catch {
    return []
  }
}

// ── Tencent device-flow OAuth ───────────────────────────────────────────────
// Ported from 9router (src/lib/oauth/providers/codebuddy-cn.js + open-sse token
// refresh). Tokens are standard JWTs; ~1yr validity per the upstream design.

const CN_BASE = 'https://copilot.tencent.com/v2/plugin/auth'
const CN_HEADERS = {
  'X-Domain': 'copilot.tencent.com',
  'X-Product': 'SaaS',
  'X-Requested-With': 'XMLHttpRequest',
  'Content-Type': 'application/json',
} as const

export type CodeBuddyCnDeviceCode = {
  state: string
  authUrl: string
}

export async function requestCodeBuddyCnDeviceCode(
  platform = 'cli',
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<CodeBuddyCnDeviceCode> {
  const res = await fetchFn(`${CN_BASE}/state?platform=${platform}`, {
    method: 'POST',
    headers: { ...CN_HEADERS, 'X-No-Authorization': '1', 'X-No-User-Id': '1' },
    body: '{}',
  })
  const json = (await res.json()) as {
    data?: { state?: string; authUrl?: string }
  }
  const state = json.data?.state
  const authUrl = json.data?.authUrl
  if (!state || !authUrl)
    throw new Error('CodeBuddy CN device-code request failed')
  return { state, authUrl }
}

export async function pollCodeBuddyCnToken(
  state: string,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<CodeBuddyCnAuthTokens | null> {
  const res = await fetchFn(
    `${CN_BASE}/token?state=${encodeURIComponent(state)}`,
    {
      method: 'GET',
      headers: {
        ...CN_HEADERS,
        'X-No-Authorization': '1',
        'X-No-User-Id': '1',
      },
    },
  )
  const json = (await res.json()) as {
    code?: number
    data?: { accessToken?: string; refreshToken?: string; expiresIn?: number }
  }
  if (json.code === 11217) return null // pending
  if (json.code !== 0 || !json.data?.accessToken || !json.data?.refreshToken)
    throw new Error(`CodeBuddy CN token poll failed (code=${json.code})`)
  const now = Date.now()
  return {
    accountId: `cn-${state.slice(0, 8)}`,
    accessToken: json.data.accessToken,
    refreshToken: json.data.refreshToken,
    ...(json.data.expiresIn
      ? { expiresAt: new Date(now + json.data.expiresIn * 1000).toISOString() }
      : {}),
    lastRefresh: new Date().toISOString(),
  }
}

export async function refreshCodeBuddyCnToken(
  refreshToken: string,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<CodeBuddyCnAuthTokens | null> {
  const res = await fetchFn(`${CN_BASE}/token/refresh`, {
    method: 'POST',
    headers: { ...CN_HEADERS, 'X-Refresh-Token': refreshToken },
    body: '{}',
  })
  if (!res.ok) {
    routeError(`cn refresh failed: ${res.status}`)
    return null
  }
  const json = (await res.json()) as {
    data?: { accessToken?: string; refreshToken?: string; expiresIn?: number }
  }
  if (!json.data?.accessToken || !json.data?.refreshToken) return null
  const now = Date.now()
  return {
    accountId: '',
    accessToken: json.data.accessToken,
    refreshToken: json.data.refreshToken,
    ...(json.data.expiresIn
      ? { expiresAt: new Date(now + json.data.expiresIn * 1000).toISOString() }
      : {}),
    lastRefresh: new Date().toISOString(),
  }
}
