import { chmod, mkdir, readFile, stat, unlink, writeFile } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import { createServer, type Server } from 'node:http'
import {
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
} from 'node:crypto'
import { routeLog } from '../../routing/stageLog.js'

const ISSUER = 'https://auth.openai.com'
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const AUTH_FILE = 'openai-chatgpt-auth.json'
const QUOTA_FILE = 'openai-chatgpt-quota.json'
const REFRESH_SKEW_MS = 5 * 60 * 1000
const QUOTA_RECHECK_MS = 5 * 60 * 1000
const CHATGPT_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'
const OMNIROUTE_CREDENTIAL_PREFIX = 'enc:v1:'
const OMNIROUTE_CREDENTIAL_SALT = 'omniroute-field-encryption-v1'

export type ChatGPTDeviceCode = {
  verificationUrl: string
  userCode: string
  deviceAuthId: string
  intervalSeconds: number
}

export type ChatGPTAuthTokens = {
  idToken: string
  accessToken: string
  refreshToken: string
  accountId?: string
  lastRefresh?: string
}

export type ChatGPTAuth = {
  accessToken: string
  accountId?: string
}

type StoredAuthFile = {
  auth_mode?: string
  tokens?: {
    id_token?: string
    access_token?: string
    refresh_token?: string
    account_id?: string
  }
  last_refresh?: string
}

type StoredAuthPoolFile = {
  auth_mode: 'chatgpt'
  accounts: StoredAuthFile[]
}

type ChatGPTQuotaLock = {
  exhaustedAt: string
  checkedAt: string
  resetAt?: string
  reason?: 'auth'
}

type StoredChatGPTQuotaFile = {
  accounts: Record<string, ChatGPTQuotaLock>
}

type OmniRouteAuthRow = {
  id: string
  provider: string
  name: string
  email: string
  id_token: string | null
  access_token: string | null
  refresh_token: string | null
  provider_specific_data: string | null
}

function authFilePath(): string {
  return join(getClaudeConfigHomeDirLocal(), AUTH_FILE)
}

function quotaFilePath(): string {
  return join(getClaudeConfigHomeDirLocal(), QUOTA_FILE)
}

function getClaudeConfigHomeDirLocal(): string {
  return (
    process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')
  ).normalize('NFC')
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function parseJSONRecord(text: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(text) as unknown
    return value && typeof value === 'object'
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const [, payload] = token.split('.')
  if (!payload) return null
  try {
    const normalized = payload.replace(/-/g, '+').replace(/_/g, '/')
    const padded = normalized.padEnd(
      normalized.length + ((4 - (normalized.length % 4)) % 4),
      '=',
    )
    const json = Buffer.from(padded, 'base64').toString('utf8')
    return parseJSONRecord(json)
  } catch {
    return null
  }
}

function getOpenAIAuthClaims(token: string): Record<string, unknown> {
  const payload = decodeJwtPayload(token)
  const nested = payload?.['https://api.openai.com/auth']
  if (nested && typeof nested === 'object') {
    return nested as Record<string, unknown>
  }
  return payload ?? {}
}

function getTokenExpiryMs(token: string): number | null {
  const payload = decodeJwtPayload(token)
  const exp = payload?.exp
  return typeof exp === 'number' ? exp * 1000 : null
}

function extractAccountId(tokens: {
  idToken?: string
  accessToken?: string
  accountId?: string
}): string | undefined {
  if (tokens.accountId) return tokens.accountId
  for (const token of [tokens.idToken, tokens.accessToken]) {
    if (!token) continue
    const claims = getOpenAIAuthClaims(token)
    const accountId =
      asString(claims.chatgpt_account_id) ??
      asString(claims.chatgpt_account_user_id) ??
      asString(claims.account_id)
    if (accountId) return accountId
  }
  return undefined
}

function parseStoredAuth(value: unknown): ChatGPTAuthTokens | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const parsed = value as StoredAuthFile
  if (parsed.auth_mode !== undefined && parsed.auth_mode !== 'chatgpt') {
    return null
  }
  const tokens = parsed.tokens
  const idToken = tokens?.id_token
  const accessToken = tokens?.access_token
  const refreshToken = tokens?.refresh_token
  if (!idToken || !accessToken || !refreshToken) return null
  return {
    idToken,
    accessToken,
    refreshToken,
    accountId: extractAccountId({
      idToken,
      accessToken,
      accountId: tokens.account_id,
    }),
    lastRefresh: parsed.last_refresh,
  }
}

async function readStoredAuthPool(): Promise<ChatGPTAuthTokens[]> {
  try {
    const raw = await readFile(authFilePath(), 'utf8')
    const parsed = JSON.parse(raw) as StoredAuthPoolFile | StoredAuthFile
    const accounts = Array.isArray((parsed as StoredAuthPoolFile).accounts)
      ? (parsed as StoredAuthPoolFile).accounts
      : [parsed as StoredAuthFile]
    return accounts
      .map(parseStoredAuth)
      .filter((auth): auth is ChatGPTAuthTokens => auth !== null)
  } catch {
    return []
  }
}

function asQuotaLock(value: unknown): ChatGPTQuotaLock | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const entry = value as Record<string, unknown>
  const exhaustedAt = asString(entry.exhaustedAt)
  const checkedAt = asString(entry.checkedAt)
  if (!exhaustedAt || !checkedAt) return null
  const resetAt = asString(entry.resetAt)
  return {
    exhaustedAt,
    checkedAt,
    ...(resetAt ? { resetAt } : {}),
    ...(entry.reason === 'auth' ? { reason: 'auth' as const } : {}),
  }
}

async function readQuotaLocks(): Promise<Record<string, ChatGPTQuotaLock>> {
  try {
    const parsed = JSON.parse(
      await readFile(quotaFilePath(), 'utf8'),
    ) as StoredChatGPTQuotaFile
    const accounts = parsed.accounts
    if (!accounts || typeof accounts !== 'object' || Array.isArray(accounts))
      return {}
    return Object.fromEntries(
      Object.entries(accounts).flatMap(([accountId, entry]) => {
        const lock = asQuotaLock(entry)
        return lock ? [[accountId, lock]] : []
      }),
    )
  } catch {
    return {}
  }
}

let quotaLocksCache: Record<string, ChatGPTQuotaLock> | undefined
let quotaLocksPath: string | undefined
let quotaLocksRevision: string | undefined

async function quotaFileRevision(path: string): Promise<string | undefined> {
  try {
    const metadata = await stat(path)
    return `${metadata.mtimeMs}:${metadata.size}`
  } catch {
    return undefined
  }
}

async function quotaLocks(): Promise<Record<string, ChatGPTQuotaLock>> {
  const path = quotaFilePath()
  const revision = await quotaFileRevision(path)
  if (
    quotaLocksPath !== path ||
    quotaLocksCache === undefined ||
    quotaLocksRevision !== revision
  ) {
    quotaLocksPath = path
    quotaLocksCache = await readQuotaLocks()
    quotaLocksRevision = revision
  }
  return quotaLocksCache ?? {}
}

async function saveQuotaLocks(
  accounts: Record<string, ChatGPTQuotaLock>,
): Promise<void> {
  quotaLocksPath = quotaFilePath()
  quotaLocksCache = accounts
  await mkdir(getClaudeConfigHomeDirLocal(), { recursive: true })
  await writeFile(
    quotaFilePath(),
    `${JSON.stringify({ accounts }, null, 2)}\n`,
    { mode: 0o600 },
  )
  await chmod(quotaFilePath(), 0o600).catch(() => undefined)
  quotaLocksRevision = await quotaFileRevision(quotaFilePath())
}

function parseResetAt(value: unknown): string | undefined {
  if (typeof value !== 'string' && typeof value !== 'number') return undefined
  const numeric = typeof value === 'number' ? value : Number(value)
  const date =
    Number.isFinite(numeric) && String(value).trim() !== ''
      ? new Date(numeric < 1e12 ? numeric * 1000 : numeric)
      : new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

function quotaWindowExhausted(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const window = value as Record<string, unknown>
  const used = Number(window.used_percent ?? window.usedPercent)
  return Number.isFinite(used) && used >= 100
}

function quotaResetAt(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return undefined
  const window = value as Record<string, unknown>
  return (
    parseResetAt(window.reset_at ?? window.resetAt) ??
    (typeof window.reset_after_seconds === 'number' ||
    typeof window.resetAfterSeconds === 'number'
      ? parseResetAt(
          Date.now() +
            Number(window.reset_after_seconds ?? window.resetAfterSeconds) *
              1000,
        )
      : undefined)
  )
}

type LiveQuotaStatus =
  | { state: 'exhausted'; lock: ChatGPTQuotaLock }
  | { state: 'available' }
  | { state: 'unknown' }

async function readLiveQuotaStatus(
  auth: ChatGPTAuth,
  fetchFn: typeof fetch = globalThis.fetch,
): Promise<LiveQuotaStatus> {
  const response = await fetchFn(CHATGPT_USAGE_URL, {
    headers: {
      Authorization: `Bearer ${auth.accessToken}`,
      Accept: 'application/json',
      ...(auth.accountId ? { 'chatgpt-account-id': auth.accountId } : {}),
    },
  })
  if (!response.ok) return { state: 'unknown' }
  const body = (await response.json()) as Record<string, unknown>
  const rateLimit = (body.rate_limit ?? body.rateLimit) as unknown
  if (!rateLimit || typeof rateLimit !== 'object') return { state: 'unknown' }
  const limit = rateLimit as Record<string, unknown>
  const primary = limit.primary_window ?? limit.primaryWindow
  const secondary = limit.secondary_window ?? limit.secondaryWindow
  if (
    (!primary || typeof primary !== 'object') &&
    (!secondary || typeof secondary !== 'object')
  ) {
    return { state: 'unknown' }
  }
  const exhausted = [primary, secondary].some(quotaWindowExhausted)
  if (!exhausted) return { state: 'available' }
  // A depleted weekly window continues to block after its shorter session
  // window resets; retain its reset time rather than the earliest one.
  const resetAt = quotaWindowExhausted(secondary)
    ? quotaResetAt(secondary)
    : quotaResetAt(primary)
  const now = new Date().toISOString()
  return {
    state: 'exhausted',
    lock: { exhaustedAt: now, checkedAt: now, ...(resetAt ? { resetAt } : {}) },
  }
}

async function isQuotaLocked(auth: ChatGPTAuth): Promise<boolean> {
  if (!auth.accountId) return false
  const locks = await quotaLocks()
  const lock = locks[auth.accountId]
  if (!lock) return false
  if (lock.reason === 'auth') {
    routeLog('request', 'codex auth rejection skip', {
      account: auth.accountId,
    })
    return true
  }
  const resetMs = lock.resetAt ? new Date(lock.resetAt).getTime() : NaN
  if (Number.isFinite(resetMs) && resetMs <= Date.now()) {
    delete locks[auth.accountId]
    await saveQuotaLocks(locks)
    routeLog('request', 'codex quota reset', { account: auth.accountId })
    return false
  }
  if (Number.isFinite(resetMs)) {
    routeLog('request', 'codex quota skip', {
      account: auth.accountId,
      resetAt: lock.resetAt,
    })
    return true
  }
  if (Date.now() - new Date(lock.checkedAt).getTime() < QUOTA_RECHECK_MS) {
    routeLog('request', 'codex quota skip', {
      account: auth.accountId,
      resetAt: lock.resetAt,
    })
    return true
  }
  try {
    const refreshed = await readLiveQuotaStatus(auth)
    if (refreshed.state === 'exhausted') {
      locks[auth.accountId] = refreshed.lock
      await saveQuotaLocks(locks)
      routeLog('request', 'codex quota still exhausted', {
        account: auth.accountId,
        resetAt: refreshed.lock.resetAt,
      })
      return true
    }
    if (refreshed.state === 'unknown') return true
    delete locks[auth.accountId]
    await saveQuotaLocks(locks)
    routeLog('request', 'codex quota restored', { account: auth.accountId })
    return false
  } catch {
    return true
  }
}

async function saveStoredAuth(tokens: ChatGPTAuthTokens): Promise<void> {
  const existing = await readStoredAuthPool()
  const accountId = extractAccountId(tokens)
  const locks = await quotaLocks()
  if (accountId && locks[accountId]?.reason === 'auth') {
    delete locks[accountId]
    await saveQuotaLocks(locks)
  }
  const accounts = [
    ...existing.filter(auth => auth.accountId !== accountId),
    { ...tokens, accountId },
  ]
  await saveStoredAuthPool(accounts)
}

async function saveStoredAuthPool(
  accounts: ChatGPTAuthTokens[],
): Promise<void> {
  const path = authFilePath()
  await mkdir(getClaudeConfigHomeDirLocal(), { recursive: true })
  const body: StoredAuthPoolFile = {
    auth_mode: 'chatgpt',
    accounts: accounts.map(tokens => ({
      tokens: {
        id_token: tokens.idToken,
        access_token: tokens.accessToken,
        refresh_token: tokens.refreshToken,
        account_id: extractAccountId(tokens),
      },
      last_refresh: new Date().toISOString(),
    })),
  }
  await writeFile(path, `${JSON.stringify(body, null, 2)}\n`, {
    mode: 0o600,
  })
  await chmod(path, 0o600).catch(() => undefined)
}

async function postJSON<T>(
  url: string,
  body: Record<string, string>,
): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    throw new Error(`ChatGPT auth request failed (${res.status})`)
  }
  return (await res.json()) as T
}

async function postForm<T>(url: string, body: URLSearchParams): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(
      `ChatGPT token request failed (${res.status})${text ? `: ${text}` : ''}`,
    )
  }
  return (await res.json()) as T
}

export async function requestChatGPTDeviceCode(): Promise<ChatGPTDeviceCode> {
  type UserCodeResponse = {
    device_auth_id: string
    user_code?: string
    usercode?: string
    interval?: string | number
  }
  const data = await postJSON<UserCodeResponse>(
    `${ISSUER}/api/accounts/deviceauth/usercode`,
    { client_id: CLIENT_ID },
  )
  const userCode = data.user_code ?? data.usercode
  if (!data.device_auth_id || !userCode) {
    throw new Error('ChatGPT auth response did not include a device code')
  }
  const interval =
    typeof data.interval === 'number'
      ? data.interval
      : Number.parseInt(data.interval ?? '5', 10)
  return {
    verificationUrl: `${ISSUER}/codex/device`,
    userCode,
    deviceAuthId: data.device_auth_id,
    intervalSeconds: Number.isFinite(interval) && interval > 0 ? interval : 5,
  }
}

async function pollForAuthorizationCode(
  deviceCode: ChatGPTDeviceCode,
  signal?: AbortSignal,
): Promise<{ authorizationCode: string; codeVerifier: string }> {
  type TokenPollResponse = {
    authorization_code: string
    code_verifier: string
  }
  const started = Date.now()
  while (Date.now() - started < 15 * 60 * 1000) {
    if (signal?.aborted) throw new Error('ChatGPT login cancelled')
    const res = await fetch(`${ISSUER}/api/accounts/deviceauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        device_auth_id: deviceCode.deviceAuthId,
        user_code: deviceCode.userCode,
      }),
      signal,
    })
    if (res.ok) {
      const data = (await res.json()) as TokenPollResponse
      return {
        authorizationCode: data.authorization_code,
        codeVerifier: data.code_verifier,
      }
    }
    if (res.status !== 403 && res.status !== 404) {
      throw new Error(`ChatGPT device auth failed (${res.status})`)
    }
    await new Promise(resolve =>
      setTimeout(resolve, deviceCode.intervalSeconds * 1000),
    )
  }
  throw new Error('ChatGPT device auth timed out after 15 minutes')
}

async function exchangeAuthorizationCode(params: {
  authorizationCode: string
  codeVerifier: string
}): Promise<ChatGPTAuthTokens> {
  type TokenResponse = {
    id_token: string
    access_token: string
    refresh_token: string
  }
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: params.authorizationCode,
    redirect_uri: `${ISSUER}/deviceauth/callback`,
    client_id: CLIENT_ID,
    code_verifier: params.codeVerifier,
  })
  const data = await postForm<TokenResponse>(`${ISSUER}/oauth/token`, body)
  return {
    idToken: data.id_token,
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    accountId: extractAccountId({
      idToken: data.id_token,
      accessToken: data.access_token,
    }),
  }
}

async function refreshTokens(
  tokens: ChatGPTAuthTokens,
): Promise<ChatGPTAuthTokens> {
  type TokenResponse = {
    id_token: string
    access_token: string
    refresh_token?: string
  }
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: tokens.refreshToken,
    client_id: CLIENT_ID,
    scope:
      'openid profile email offline_access api.connectors.read api.connectors.invoke',
  })
  const data = await postForm<TokenResponse>(`${ISSUER}/oauth/token`, body)
  return {
    idToken: data.id_token,
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? tokens.refreshToken,
    accountId: extractAccountId({
      idToken: data.id_token,
      accessToken: data.access_token,
      accountId: tokens.accountId,
    }),
  }
}

export async function completeChatGPTDeviceLogin(
  deviceCode: ChatGPTDeviceCode,
  signal?: AbortSignal,
): Promise<ChatGPTAuthTokens> {
  const code = await pollForAuthorizationCode(deviceCode, signal)
  const tokens = await exchangeAuthorizationCode(code)
  await saveStoredAuth(tokens)
  return tokens
}

export function isChatGPTAuthEnabled(): boolean {
  return process.env.OPENAI_AUTH_MODE === 'chatgpt'
}

export async function removeChatGPTAuth(): Promise<void> {
  quotaLocksCache = undefined
  quotaLocksPath = undefined
  quotaLocksRevision = undefined
  await Promise.all(
    [authFilePath(), quotaFilePath()].map(path =>
      unlink(path).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }),
    ),
  )
}

const failedChatGPTAccounts = new Set<string>()

/** Explicit one-time import. Runtime only reads CCB's 0600 auth pool. */
export async function importChatGPTAuthFiles(
  paths: readonly string[],
): Promise<number> {
  const imported: ChatGPTAuthTokens[] = []
  for (const path of paths) {
    const parsed = parseJSONRecord(await readFile(path, 'utf8'))
    const entries = Array.isArray(parsed?.accounts) ? parsed.accounts : [parsed]
    const tokens = entries
      .map(parseStoredAuth)
      .filter((item): item is ChatGPTAuthTokens => Boolean(item?.accountId))
    if (tokens.length !== entries.length) {
      throw new Error(`Invalid Codex auth file: ${path}`)
    }
    imported.push(...tokens)
  }
  await mergeStoredAuthPool(imported)
  return imported.length
}

function decryptOmniRouteCredential(value: string, key?: string): string {
  if (!value.startsWith(OMNIROUTE_CREDENTIAL_PREFIX)) return value
  if (!key) {
    throw new Error(
      'OmniRoute credentials are encrypted; set OMNIROUTE_STORAGE_ENCRYPTION_KEY for this one-time import.',
    )
  }
  const [ivHex, encryptedHex, authTagHex] = value
    .slice(OMNIROUTE_CREDENTIAL_PREFIX.length)
    .split(':')
  if (!ivHex || !encryptedHex || !authTagHex) {
    throw new Error('OmniRoute credential is malformed.')
  }
  const decipher = createDecipheriv(
    'aes-256-gcm',
    scryptSync(key, OMNIROUTE_CREDENTIAL_SALT, 32),
    Buffer.from(ivHex, 'hex'),
    { authTagLength: 16 },
  )
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'))
  return decipher.update(encryptedHex, 'hex', 'utf8') + decipher.final('utf8')
}

function tokensFromOmniRouteRow(
  row: OmniRouteAuthRow,
  encryptionKey?: string,
): ChatGPTAuthTokens | null {
  if (!row.id_token || !row.access_token || !row.refresh_token) return null
  const idToken = decryptOmniRouteCredential(row.id_token, encryptionKey)
  const accessToken = decryptOmniRouteCredential(
    row.access_token,
    encryptionKey,
  )
  const refreshToken = decryptOmniRouteCredential(
    row.refresh_token,
    encryptionKey,
  )
  const providerData = row.provider_specific_data
    ? parseJSONRecord(row.provider_specific_data)
    : null
  const accountId = extractAccountId({
    idToken,
    accessToken,
    accountId: asString(providerData?.workspaceId),
  })
  return accountId
    ? {
        idToken,
        accessToken,
        refreshToken,
        accountId,
      }
    : null
}

async function importQuotaLocksFromOmniRoute(
  databasePath: string,
  imported: readonly OmniRouteAuthRow[],
): Promise<void> {
  if (!imported.length) return
  const connectionIds = imported.map(row => row.id)
  const placeholders = connectionIds.map(() => '?').join(', ')
  const query = `SELECT connection_id, window_key, is_exhausted, next_reset_at
    FROM quota_snapshots
    WHERE connection_id IN (${placeholders})
    ORDER BY created_at DESC`
  type Snapshot = {
    connection_id: string
    window_key: string
    is_exhausted: number
    next_reset_at: string | null
  }
  const rows: Snapshot[] =
    typeof Bun !== 'undefined'
      ? await (async () => {
          const { Database } = await import('bun:sqlite')
          const database = new Database(databasePath, { readonly: true })
          try {
            return database
              .query<Snapshot, string[]>(query)
              .all(...connectionIds)
          } finally {
            database.close()
          }
        })()
      : []
  const latest = new Map<string, Snapshot>()
  for (const row of rows) {
    const key = `${row.connection_id}\u0000${row.window_key}`
    if (!latest.has(key)) latest.set(key, row)
  }
  const exhausted = new Map<string, Snapshot[]>()
  const checked = new Set<string>()
  for (const snapshot of latest.values()) {
    checked.add(snapshot.connection_id)
    if (snapshot.is_exhausted) {
      const entries = exhausted.get(snapshot.connection_id) ?? []
      entries.push(snapshot)
      exhausted.set(snapshot.connection_id, entries)
    }
  }
  if (!checked.size) return
  const locks = await quotaLocks()
  const now = new Date().toISOString()
  let changed = false
  for (const connectionId of checked) {
    const account = imported.find(item => item.id === connectionId)
    const tokens = account
      ? tokensFromOmniRouteRow(
          account,
          process.env.OMNIROUTE_STORAGE_ENCRYPTION_KEY ??
            process.env.STORAGE_ENCRYPTION_KEY,
        )
      : null
    if (!tokens?.accountId) continue
    const snapshots = exhausted.get(connectionId)
    if (!snapshots) {
      if (locks[tokens.accountId]?.reason === 'auth') continue
      if (locks[tokens.accountId]) {
        delete locks[tokens.accountId]
        changed = true
      }
      failedChatGPTAccounts.delete(tokens.accountId)
      continue
    }
    const resetAt = snapshots
      .map(snapshot => snapshot.next_reset_at)
      .filter((value): value is string => Boolean(value))
      .sort()
      .at(-1)
    if (resetAt && new Date(resetAt).getTime() <= Date.now()) continue
    locks[tokens.accountId] = {
      exhaustedAt: now,
      checkedAt: now,
      ...(resetAt ? { resetAt } : {}),
    }
    changed = true
  }
  if (changed) await saveQuotaLocks(locks)
}

async function mergeStoredAuthPool(
  imported: ChatGPTAuthTokens[],
  clearAuthLocks = true,
): Promise<void> {
  const existing = await readStoredAuthPool()
  const byAccount = new Map(existing.map(auth => [auth.accountId, auth]))
  for (const tokens of imported) byAccount.set(tokens.accountId, tokens)
  const locks = await quotaLocks()
  let changed = false
  for (const tokens of imported) {
    if (
      clearAuthLocks &&
      tokens.accountId &&
      locks[tokens.accountId]?.reason === 'auth'
    ) {
      delete locks[tokens.accountId]
      changed = true
    }
  }
  if (changed) await saveQuotaLocks(locks)
  await saveStoredAuthPool([...byAccount.values()])
}

/**
 * Explicit, one-time migration from OmniRoute's local SQLite database.
 * The source database is opened read-only; runtime never consults it again.
 */
export async function importChatGPTAuthFromOmniRoute(
  databasePath: string,
): Promise<number> {
  const query = `SELECT id, id_token, access_token, refresh_token, provider_specific_data
    FROM provider_connections
    WHERE lower(provider) IN ('codex', 'kilocode')
      AND auth_type = 'oauth'
      AND is_active = 1`
  const rows: OmniRouteAuthRow[] =
    typeof Bun !== 'undefined'
      ? await (async () => {
          const { Database } = await import('bun:sqlite')
          const database = new Database(databasePath, { readonly: true })
          try {
            return database.query<OmniRouteAuthRow, []>(query).all()
          } finally {
            database.close()
          }
        })()
      : await (async () => {
          const { DatabaseSync } = await import('node:sqlite')
          const database = new DatabaseSync(databasePath, { readOnly: true })
          try {
            return database.prepare(query).all() as OmniRouteAuthRow[]
          } finally {
            database.close()
          }
        })()
  const imported = rows
    .map(row =>
      tokensFromOmniRouteRow(
        row,
        process.env.OMNIROUTE_STORAGE_ENCRYPTION_KEY ??
          process.env.STORAGE_ENCRYPTION_KEY,
      ),
    )
    .filter((tokens): tokens is ChatGPTAuthTokens => tokens !== null)
  if (imported.length) {
    await mergeStoredAuthPool(imported, false)
    await importQuotaLocksFromOmniRoute(databasePath, rows)
  }
  return imported.length
}

export async function hasChatGPTAccountPool(): Promise<boolean> {
  return (await readStoredAuthPool()).length > 0
}

export function markChatGPTAccountFailure(auth: ChatGPTAuth): void {
  if (auth.accountId) failedChatGPTAccounts.add(auth.accountId)
}

/** Persist only confirmed subscription exhaustion. Ordinary failures remain
 * process-local so a transient network error never suppresses an account. */
export async function markChatGPTAccountQuotaExhausted(
  auth: ChatGPTAuth,
  fetchFn?: typeof fetch,
): Promise<void> {
  if (!auth.accountId) return
  failedChatGPTAccounts.add(auth.accountId)
  const locks = await quotaLocks()
  const now = new Date().toISOString()
  locks[auth.accountId] = { exhaustedAt: now, checkedAt: now }
  await saveQuotaLocks(locks)
  routeLog('request', 'codex subscription quota exhausted', {
    account: auth.accountId,
  })
  try {
    const live = await readLiveQuotaStatus(auth, fetchFn)
    if (live.state === 'exhausted') {
      locks[auth.accountId] = live.lock
      await saveQuotaLocks(locks)
      routeLog('request', 'codex quota reset known', {
        account: auth.accountId,
        resetAt: live.lock.resetAt,
      })
    }
  } catch {
    // The explicit Responses error already proves exhaustion. Retain the lock.
  }
}

export function clearChatGPTAccountFailure(auth: ChatGPTAuth): void {
  if (auth.accountId) failedChatGPTAccounts.delete(auth.accountId)
}

/**
 * Persist an auth rejection (401/403) so the account is durably skipped across
 * processes instead of only within the current one.
 *
 * Without this, every fresh `bun run dev` re-reads the pool and re-tries dead
 * accounts forever: the process-local `failedChatGPTAccounts` Set is lost on
 * restart, and the quota lock file only ever gets written for explicit quota
 * exhaustion — so a plain 401 (e.g. a 0%-quota Codex subscription) was treated
 * as a transient, per-process failure and retried indefinitely.
 *
 * A later CCB login or explicit import for this account clears the lock.
 */
export async function markChatGPTAccountAuthRejected(
  auth: ChatGPTAuth,
): Promise<void> {
  if (!auth.accountId) return
  failedChatGPTAccounts.add(auth.accountId)
  const locks = await quotaLocks()
  const now = new Date().toISOString()
  locks[auth.accountId] = { exhaustedAt: now, checkedAt: now, reason: 'auth' }
  await saveQuotaLocks(locks)
  routeLog('request', 'codex auth rejected (persisted lock)', {
    account: auth.accountId,
  })
}

export async function getValidChatGPTAuth(): Promise<ChatGPTAuth> {
  const accounts = await readStoredAuthPool()
  if (!accounts.length) {
    throw new Error(
      'ChatGPT account is not logged in. Run /login and select ChatGPT account with subscription.',
    )
  }
  for (let tokens of accounts) {
    const accountId = tokens.accountId ?? extractAccountId(tokens)
    if (accountId && failedChatGPTAccounts.has(accountId)) {
      // A runtime failure normally stays failed for this process. Quota locks
      // are different: their recorded reset/recheck is the only point at
      // which this process may try the account again.
      const lock = (await quotaLocks())[accountId]
      if (!lock || lock.reason === 'auth') continue
      const resetMs = lock.resetAt ? new Date(lock.resetAt).getTime() : NaN
      if (!Number.isFinite(resetMs) || resetMs > Date.now()) continue
      if (await isQuotaLocked({ accessToken: tokens.accessToken, accountId }))
        continue
      failedChatGPTAccounts.delete(accountId)
    }
    try {
      const expiresAt = getTokenExpiryMs(tokens.accessToken)
      if (expiresAt !== null && expiresAt <= Date.now() + REFRESH_SKEW_MS) {
        tokens = await refreshTokens(tokens)
        await saveStoredAuth(tokens)
      }
      const auth = {
        accessToken: tokens.accessToken,
        accountId: tokens.accountId ?? extractAccountId(tokens),
      }
      if (await isQuotaLocked(auth)) {
        if (auth.accountId) failedChatGPTAccounts.add(auth.accountId)
        continue
      }
      return auth
    } catch {
      if (tokens.accountId) failedChatGPTAccounts.add(tokens.accountId)
    }
  }
  throw new Error('No ChatGPT account has a valid token.')
}

// ──────────────────────────────────────────────────────────────────────────
// Account login (PKCE browser callback flow)
//
// Counterpart to the device-code flow above. The user picks "Account login"
// in /login when running on a machine with a browser; we open the OpenAI
// authorize endpoint with PKCE, run a localhost callback server on
// 127.0.0.1:1455, exchange the code for tokens, and persist the same
// StoredAuthFile format the device flow writes — so getValidChatGPTAuth()
// reads either login method's result transparently.
//
// Ported from OmniRoute src/lib/oauth/providers/codex.ts (CODEX_CONFIG:
// extraParams id_token_add_organizations / codex_cli_simplified_flow /
// originator=codex_cli_rs / prompt=login). prompt=login is mandatory for
// multi-account isolation on the same client_id (see OmniRoute comment).
//
// IPv6 is disabled on this host — the callback server MUST bind 127.0.0.1
// (never `localhost` / `::1`), and the redirect_uri must use 127.0.0.1.
// ──────────────────────────────────────────────────────────────────────────

const ACCOUNT_LOGIN_HOST = '127.0.0.1'
const ACCOUNT_LOGIN_PORT = 1455
const ACCOUNT_LOGIN_CALLBACK_PATH = '/auth/callback'
const ACCOUNT_LOGIN_REDIRECT_URI = `http://${ACCOUNT_LOGIN_HOST}:${ACCOUNT_LOGIN_PORT}${ACCOUNT_LOGIN_CALLBACK_PATH}`

// Codex OAuth extra params (mirrors OmniRoute CODEX_CONFIG.extraParams)
const CODEX_EXTRA_PARAMS: Record<string, string> = {
  id_token_add_organizations: 'true',
  codex_cli_simplified_flow: 'true',
  originator: 'codex_cli_rs',
  prompt: 'login',
}
const CODEX_PKCE_SCOPE = 'openid profile email offline_access'

function base64url(buffer: Buffer): string {
  return buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

function generatePkceVerifier(): string {
  // 32 random bytes → 43 base64url chars (RFC 7636 minimum length)
  return base64url(randomBytes(32))
}

function computePkceChallenge(verifier: string): string {
  return base64url(createHash('sha256').update(verifier).digest())
}

function buildAccountLoginAuthUrl(verifier: string, state: string): string {
  const challenge = computePkceChallenge(verifier)
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: ACCOUNT_LOGIN_REDIRECT_URI,
    scope: CODEX_PKCE_SCOPE,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    ...CODEX_EXTRA_PARAMS,
  })
  return `${ISSUER}/oauth/authorize?${params.toString()}`
}

async function exchangeAccountLoginCode(params: {
  code: string
  codeVerifier: string
}): Promise<ChatGPTAuthTokens> {
  type TokenResponse = {
    id_token: string
    access_token: string
    refresh_token: string
  }
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: params.code,
    redirect_uri: ACCOUNT_LOGIN_REDIRECT_URI,
    client_id: CLIENT_ID,
    code_verifier: params.codeVerifier,
  })
  const data = await postForm<TokenResponse>(`${ISSUER}/oauth/token`, body)
  return {
    idToken: data.id_token,
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    accountId: extractAccountId({
      idToken: data.id_token,
      accessToken: data.access_token,
    }),
  }
}

export type ChatGPTAccountLoginHandle = {
  /** Authorize URL to open in the user's browser. */
  authUrl: string
  /** Resolve once the browser callback completes and tokens are persisted. */
  waitForCompletion(signal?: AbortSignal): Promise<ChatGPTAuthTokens>
}

/**
 * Start the account-login (PKCE browser callback) flow.
 *
 * Opens a localhost callback server on 127.0.0.1:1455 and returns the authUrl
 * the caller should pass to openBrowser(). The caller then awaits
 * waitForCompletion() to get the persisted tokens.
 *
 * If port 1455 is already in use (e.g. another login in flight), the server's
 * 'error' event rejects the completion promise with EADDRINUSE.
 */
export function requestChatGPTAccountLogin(): ChatGPTAccountLoginHandle {
  const verifier = generatePkceVerifier()
  const state = base64url(randomBytes(16))
  const authUrl = buildAccountLoginAuthUrl(verifier, state)

  let server: Server | undefined
  let settled = false
  let rejectCompletion: (reason?: unknown) => void

  const completion = new Promise<ChatGPTAuthTokens>((resolve, reject) => {
    rejectCompletion = reject
    server = createServer((req, res) => {
      const url = req.url ?? ''
      if (!url.startsWith(ACCOUNT_LOGIN_CALLBACK_PATH)) {
        res.statusCode = 404
        res.end('Not found')
        return
      }
      const parsed = new URL(url, ACCOUNT_LOGIN_REDIRECT_URI)
      const code = parsed.searchParams.get('code')
      const returnedState = parsed.searchParams.get('state')
      const errParam = parsed.searchParams.get('error')

      if (errParam) {
        res.statusCode = 400
        res.setHeader('Content-Type', 'text/html; charset=utf-8')
        res.end(
          `<html><body><h2>Login failed</h2><p>${errParam}</p></body></html>`,
        )
        if (!settled) {
          settled = true
          reject(new Error(`ChatGPT account login error: ${errParam}`))
        }
        return
      }
      if (!code || returnedState !== state) {
        res.statusCode = 400
        res.setHeader('Content-Type', 'text/plain; charset=utf-8')
        res.end('Missing code or state mismatch')
        return
      }
      res.statusCode = 200
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.end(
        '<html><body><h2>Login successful</h2><p>You can close this tab and return to the terminal.</p></body></html>',
      )
      if (!settled) {
        settled = true
        exchangeAccountLoginCode({ code, codeVerifier: verifier })
          .then(async tokens => {
            await saveStoredAuth(tokens)
            resolve(tokens)
          })
          .catch(reject)
      }
    })

    server.on('error', err => {
      if (!settled) {
        settled = true
        reject(new Error(`ChatGPT account login server failed: ${err.message}`))
      }
    })

    server.listen(ACCOUNT_LOGIN_PORT, ACCOUNT_LOGIN_HOST)
  })

  const waitForCompletion = async (
    signal?: AbortSignal,
  ): Promise<ChatGPTAuthTokens> => {
    const onAbort = () => {
      if (!settled) {
        settled = true
        rejectCompletion(new Error('ChatGPT account login cancelled'))
      }
    }
    signal?.addEventListener('abort', onAbort)
    try {
      return await completion
    } finally {
      signal?.removeEventListener('abort', onAbort)
      server?.close()
    }
  }

  return { authUrl, waitForCompletion }
}
