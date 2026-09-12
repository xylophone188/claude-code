/**
 * admission.ts — 401/403/404 准入闸 for the CCB local router.
 *
 * 401/403 (invalid credentials) and 404 (model or endpoint not found) are
 * *permanent* admission failures: retrying burns the same window with a
 * guaranteed outcome. The circuit breaker covers repeated transient
 * failures; this module covers the one-shot permanent case at route-planning
 * time so a non-admitted route is skipped before a request is attempted.
 *
 *   provider  404 on a provider route — upstream stopped serving the model,
 *              so the whole provider is excluded for the window
 *   model     404 on a specific model — that candidate is excluded; the
 *              OpenCode case also signals a stale model catalog
 *   account   401/403 on a specific key — the key is excluded
 *
 * PURE and in-memory: module-level state only (no network, no timers).
 * Callers own persistence and call `record*` from the catch path after the
 * upstream status is known.
 */

export interface AdmissionConfig {
  /** Window for a provider exclusion. Default 10 minutes. */
  providerWindowMs?: number
  /** Window for a model exclusion. Default 30 minutes. */
  modelWindowMs?: number
  /** Window for an account exclusion. Default 2 hours. */
  accountWindowMs?: number
}

const DEFAULTS: Required<AdmissionConfig> = {
  providerWindowMs: 10 * 60 * 1000,
  modelWindowMs: 30 * 60 * 1000,
  accountWindowMs: 2 * 60 * 60 * 1000,
}

const DEFAULT_STATUS = 400

interface AdmissionEntry {
  providerId: string
  model?: string
  accountId?: string
  status: number
  at: number
}

const providerAdmissions = new Map<string, AdmissionEntry>()
const modelAdmissions = new Map<string, AdmissionEntry>()
const accountAdmissions = new Map<string, AdmissionEntry>()

function providerKey(providerId: string): string {
  return providerId
}

function modelKey(providerId: string, model: string): string {
  return `${providerId}/${model}`
}

function accountKey(providerId: string, accountId: string): string {
  return `${providerId}/${accountId}`
}

function isExpired(
  entry: AdmissionEntry,
  windowMs: number,
  now: number,
): boolean {
  return now - entry.at >= windowMs
}

function normalizeConfig(config: AdmissionConfig): Required<AdmissionConfig> {
  return { ...DEFAULTS, ...config }
}

/** Record a 404 (or similar not-found) for a whole provider. */
export function recordProviderNotAdmitted(
  providerId: string,
  status: number = DEFAULT_STATUS,
  now: number = Date.now(),
): void {
  providerAdmissions.set(providerKey(providerId), {
    providerId,
    status,
    at: now,
  })
}

/** Record a 404 (or similar not-found) for a specific provider/model. */
export function recordModelNotAdmitted(
  providerId: string,
  model: string,
  status: number = DEFAULT_STATUS,
  now: number = Date.now(),
): void {
  modelAdmissions.set(modelKey(providerId, model), {
    providerId,
    model,
    status,
    at: now,
  })
}

/** Record a 401/403 for a specific provider/account (api key). */
export function recordAccountNotAdmitted(
  providerId: string,
  accountId: string,
  status: number = DEFAULT_STATUS,
  now: number = Date.now(),
): void {
  accountAdmissions.set(accountKey(providerId, accountId), {
    providerId,
    accountId,
    status,
    at: now,
  })
}

/** Whether a whole provider is still excluded. Expired entries admit. */
export function isProviderAdmitted(
  providerId: string,
  now: number = Date.now(),
  config: AdmissionConfig = {},
): boolean {
  const entry = providerAdmissions.get(providerKey(providerId))
  if (!entry) return true
  if (isExpired(entry, normalizeConfig(config).providerWindowMs, now)) {
    providerAdmissions.delete(providerKey(providerId))
    return true
  }
  return false
}

/** Whether a specific provider/model is still excluded. */
export function isModelAdmitted(
  providerId: string,
  model: string,
  now: number = Date.now(),
  config: AdmissionConfig = {},
): boolean {
  const entry = modelAdmissions.get(modelKey(providerId, model))
  if (!entry) return true
  if (isExpired(entry, normalizeConfig(config).modelWindowMs, now)) {
    modelAdmissions.delete(modelKey(providerId, model))
    return true
  }
  return false
}

/** Whether a specific provider/account is still excluded. */
export function isAccountAdmitted(
  providerId: string,
  accountId: string,
  now: number = Date.now(),
  config: AdmissionConfig = {},
): boolean {
  const entry = accountAdmissions.get(accountKey(providerId, accountId))
  if (!entry) return true
  if (isExpired(entry, normalizeConfig(config).accountWindowMs, now)) {
    accountAdmissions.delete(accountKey(providerId, accountId))
    return true
  }
  return false
}

/**
 * Status of the last still-valid model exclusion for this provider/model.
 * Used to trigger side effects such as OpenCode model-cache invalidation on
 * 404 — once, per exclusion window.
 */
export function lastModelNotAdmittedStatus(
  providerId: string,
  model: string,
  now: number = Date.now(),
): number | undefined {
  const entry = modelAdmissions.get(modelKey(providerId, model))
  if (!entry) return undefined
  if (isExpired(entry, DEFAULTS.modelWindowMs, now)) return undefined
  return entry.status
}

/** True when the last model exclusion for this provider/model was a 404
 *  within the window — signals the caller to invalidate the model catalog. */
export function isModel404Pending(
  providerId: string,
  model: string,
  now: number = Date.now(),
): boolean {
  return lastModelNotAdmittedStatus(providerId, model, now) === 404
}

/** Clear all admission state (for tests). */
export function resetAdmissions(): void {
  providerAdmissions.clear()
  modelAdmissions.clear()
  accountAdmissions.clear()
}
