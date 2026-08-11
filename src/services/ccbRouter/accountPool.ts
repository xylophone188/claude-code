import type { ProviderConfig } from '../providerRegistry/types.js'
import { routeError, routeLog } from '../routing/stageLog.js'

export interface AccountChoice {
  id: string
  apiKey: string
  model?: string
}

const cooldowns = new Map<string, number>()
const providerCooldowns = new Map<string, number>()
const modelCooldowns = new Map<string, number>()
const runtimeQuota = new Map<string, number>()
const requestSlots = new Map<string, Promise<void>>()
const requestStartedAt = new Map<string, number>()
const NVIDIA_REQUEST_INTERVAL_MS = 1_500

function modelKey(providerId: string, model: string): string {
  return `${providerId}/${model}`
}

export function providerRequestSlotKey(
  providerId: string,
  accountId?: string,
): string {
  return providerId === 'nvidia' && accountId
    ? `${providerId}/${accountId}`
    : providerId
}

function providerRequestIntervalMs(providerId: string): number {
  return providerId === 'nvidia' ? NVIDIA_REQUEST_INTERVAL_MS : 0
}

export async function waitForProviderRequestSlot(
  providerId: string,
  accountId?: string,
): Promise<void> {
  if (providerId !== 'nvidia') return
  const key = providerRequestSlotKey(providerId, accountId)
  const previous = requestSlots.get(key) ?? Promise.resolve()
  const current = previous.then(async () => {
    const lastStarted = requestStartedAt.get(key)
    const delayMs =
      lastStarted === undefined
        ? 0
        : Math.max(
            0,
            lastStarted + providerRequestIntervalMs(providerId) - Date.now(),
          )
    if (delayMs) await new Promise(resolve => setTimeout(resolve, delayMs))
    requestStartedAt.set(key, Date.now())
  })
  requestSlots.set(key, current)
  try {
    await current
  } finally {
    if (requestSlots.get(key) === current) requestSlots.delete(key)
  }
}

export function resetProviderRequestSlotsForTest(): void {
  requestSlots.clear()
  requestStartedAt.clear()
}

export function markAccountFailure(
  providerId: string,
  accountId: string,
  cooldownMs = 30_000,
): void {
  cooldowns.set(`${providerId}/${accountId}`, Date.now() + cooldownMs)
}

export function clearAccountFailure(
  providerId: string,
  accountId: string,
): void {
  cooldowns.delete(`${providerId}/${accountId}`)
}

/** Timeout/connection failures invalidate every account for this provider. */
export function markProviderFailure(
  providerId: string,
  cooldownMs = 60_000,
): void {
  providerCooldowns.set(providerId, Date.now() + cooldownMs)
}

export function isProviderFailure(providerId: string): boolean {
  const expiresAt = providerCooldowns.get(providerId)
  if (!expiresAt || expiresAt <= Date.now()) {
    providerCooldowns.delete(providerId)
    return false
  }
  return true
}

export function markModelFailure(
  providerId: string,
  model: string,
  cooldownMs = 60_000,
): void {
  modelCooldowns.set(modelKey(providerId, model), Date.now() + cooldownMs)
}

export function clearModelFailure(providerId: string, model: string): void {
  modelCooldowns.delete(modelKey(providerId, model))
}

export function isModelFailure(providerId: string, model: string): boolean {
  const key = modelKey(providerId, model)
  const expiresAt = modelCooldowns.get(key)
  if (!expiresAt || expiresAt <= Date.now()) {
    modelCooldowns.delete(key)
    return false
  }
  return true
}

export function updateAccountQuota(
  providerId: string,
  accountId: string,
  remaining: number,
): void {
  if (Number.isFinite(remaining))
    runtimeQuota.set(
      `${providerId}/${accountId}`,
      Math.max(0, Math.min(100, remaining)),
    )
}

function quotaOf(
  providerId: string,
  account: { id: string; quotaRemaining?: number },
): number | undefined {
  return (
    runtimeQuota.get(`${providerId}/${account.id}`) ?? account.quotaRemaining
  )
}

function keyOf(account: { apiKey?: string; apiKeyEnv?: string }): string {
  return (
    account.apiKey ??
    (account.apiKeyEnv ? (process.env[account.apiKeyEnv] ?? '') : '')
  )
}

export function chooseAccount(
  provider: ProviderConfig,
): AccountChoice | undefined {
  const accounts = provider.accounts?.length
    ? provider.accounts
    : [
        {
          id: 'default',
          apiKey: provider.apiKey,
          apiKeyEnv: provider.apiKeyEnv,
        },
      ]
  const usable = accounts.filter(
    account =>
      account.enabled !== false &&
      (quotaOf(provider.id, account) === undefined ||
        quotaOf(provider.id, account)! > 10) &&
      (cooldowns.get(`${provider.id}/${account.id}`) ?? 0) <= Date.now() &&
      (provider.noAuth || keyOf(account).length > 0),
  )
  if (!usable.length) {
    // Count why each account was rejected — dev needs to know if it's cooldowns,
    // empty keys, disabled, or quota exhaustion.
    const reasons = { cooldown: 0, noKey: 0, disabled: 0, quota: 0 }
    const now = Date.now()
    for (const a of accounts) {
      if (a.enabled === false) reasons.disabled++
      else if ((cooldowns.get(`${provider.id}/${a.id}`) ?? 0) > now)
        reasons.cooldown++
      else if (!provider.noAuth && !keyOf(a)) reasons.noKey++
      else {
        const q = quotaOf(provider.id, a)
        if (q !== undefined && q <= 10) reasons.quota++
      }
    }
    routeError(
      `account: ${provider.id} no usable (total=${accounts.length}) reasons=${JSON.stringify(reasons)}`,
    )
    return undefined
  }
  // ponytail: linear scan; weighted scheduling waits until account count matters.
  const selected = usable.reduce((best, account) =>
    (account.quotaRemaining ?? 100) > (best.quotaRemaining ?? 100)
      ? account
      : best,
  )
  routeLog(
    'pick',
    `account: ${provider.id} -> ${selected.id} (usable=${usable.length}/${accounts.length})`,
  )
  return {
    id: selected.id,
    apiKey: provider.noAuth ? '' : keyOf(selected),
    ...(selected.model ? { model: selected.model } : {}),
  }
}

export function chooseAccounts(provider: ProviderConfig): AccountChoice[] {
  const accounts = provider.accounts?.length
    ? provider.accounts
    : [
        {
          id: 'default',
          apiKey: provider.apiKey,
          apiKeyEnv: provider.apiKeyEnv,
        },
      ]
  const chosen = accounts
    .filter(
      account =>
        account.enabled !== false &&
        (quotaOf(provider.id, account) === undefined ||
          quotaOf(provider.id, account)! > 10) &&
        (cooldowns.get(`${provider.id}/${account.id}`) ?? 0) <= Date.now() &&
        (provider.noAuth || keyOf(account).length > 0),
    )
    .sort(
      (a, b) =>
        (quotaOf(provider.id, b) ?? 100) - (quotaOf(provider.id, a) ?? 100),
    )
    .map(account => ({
      id: account.id,
      apiKey: provider.noAuth ? '' : keyOf(account),
      ...(account.model ? { model: account.model } : {}),
    }))
  routeLog(
    'score',
    `accounts: ${provider.id} usable=${chosen.length}/${accounts.length}`,
  )
  return chosen
}

/** Race mode intentionally samples every enabled credential once, including
 * recently cooled/quota-limited accounts, so its telemetry reflects the pool. */
export function chooseAllAccounts(provider: ProviderConfig): AccountChoice[] {
  const accounts = provider.accounts?.length
    ? provider.accounts
    : [
        {
          id: 'default',
          apiKey: provider.apiKey,
          apiKeyEnv: provider.apiKeyEnv,
        },
      ]
  return accounts
    .filter(
      account =>
        account.enabled !== false &&
        (provider.noAuth || keyOf(account).length > 0),
    )
    .map(account => ({
      id: account.id,
      apiKey: provider.noAuth ? '' : keyOf(account),
      ...(account.model ? { model: account.model } : {}),
    }))
}
