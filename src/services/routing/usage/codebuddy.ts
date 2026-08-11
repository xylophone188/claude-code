/**
 * CodeBuddy CN quota probe — ported from 9router's
 * open-sse/services/usage/codebuddy-cn.js. Quota lives behind a Tencent
 * billing endpoint (POST, nested data.Response.Data.Accounts[]) that mixes
 * two credit types: recurring refill packs (Cycle* fields, the cycle resets
 * before the resource expires) and one-shot bonus packs (Capacity* fields).
 * Only the refill pack balance feeds the 0..100 remaining percentage; bonus
 * credits are one-shot and would make the number non-monotonic across months.
 */
const REFILL_GAP_MS = 2 * 24 * 60 * 60 * 1000
const TIMEOUT_MS = 5_000

/** Prefer the *Precise string fields (exact), fall back to the numeric ones. */
function num(precise: unknown, plain: unknown): number {
  const n = Number(precise ?? plain)
  return Number.isFinite(n) ? n : 0
}

/** ISO string for Unix timestamps (s or ms) and date strings; null when unparsable. */
function parseResetTime(value: unknown): string | null {
  if (!value) return null
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'number') {
    const d = new Date(value < 1e12 ? value * 1000 : value)
    return Number.isNaN(d.getTime()) ? null : d.toISOString()
  }
  if (typeof value === 'string') {
    if (/^\d+$/.test(value)) {
      const ts = Number(value)
      const d = new Date(ts < 1e12 ? ts * 1000 : ts)
      return Number.isNaN(d.getTime()) ? null : d.toISOString()
    }
    const d = new Date(value)
    return Number.isNaN(d.getTime()) ? null : d.toISOString()
  }
  return null
}

interface CodeBuddyAccount {
  CycleEndTime?: unknown
  DeductionEndTime?: unknown
  CycleCapacityUsed?: unknown
  CycleCapacitySize?: unknown
  CycleCapacityUsedPrecise?: unknown
  CycleCapacitySizePrecise?: unknown
}

/**
 * Remaining quota percentage 0..100 for the refill (recurring) pack with the
 * earliest cycle end, or undefined when there is no refill pack / any probe
 * failure. Fail-open: credential/network/parse errors all return undefined so
 * scoring degrades to neutral instead of failing the route.
 */
export async function fetchCodeBuddyQuota(
  usageUrl: string,
  apiKey: string,
  headers?: Record<string, string>,
): Promise<number | undefined> {
  if (!apiKey) return undefined
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(usageUrl, {
      method: 'POST',
      headers: {
        ...(headers ?? {}),
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: '{}',
      signal: controller.signal,
    })
    if (res.status === 401 || res.status === 403) return undefined
    if (!res.ok) return undefined
    const json = (await res.json()) as Record<string, unknown>
    if (json?.code !== 0) return undefined
    const data = json?.data as Record<string, unknown> | undefined
    const response = data?.Response as Record<string, unknown> | undefined
    const inner = response?.Data as Record<string, unknown> | undefined
    const accounts = Array.isArray(inner?.Accounts)
      ? (inner.Accounts as unknown as CodeBuddyAccount[])
      : []
    if (accounts.length === 0) return undefined

    const cycleEndMs = (acc: CodeBuddyAccount): number => {
      const r = parseResetTime(acc.CycleEndTime)
      return r ? new Date(r).getTime() : Number.POSITIVE_INFINITY
    }
    const isRefill = (acc: CodeBuddyAccount): boolean => {
      const ce = cycleEndMs(acc)
      const de = Number(acc.DeductionEndTime)
      return (
        Number.isFinite(ce) && Number.isFinite(de) && de - ce > REFILL_GAP_MS
      )
    }
    const refills = accounts.filter(isRefill)
    if (refills.length === 0) return undefined
    refills.sort((a, b) => cycleEndMs(a) - cycleEndMs(b))
    const main = refills[0]
    const size = num(main?.CycleCapacitySizePrecise, main?.CycleCapacitySize)
    const used = num(main?.CycleCapacityUsedPrecise, main?.CycleCapacityUsed)
    if (size <= 0) return undefined
    const remaining = ((size - used) / size) * 100
    return Math.min(100, Math.max(0, remaining))
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}
