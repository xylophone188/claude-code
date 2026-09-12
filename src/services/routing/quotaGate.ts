/**
 * quotaGate.ts — per-provider quota-class admission gate for the CCB local
 * router (L1 concurrency pool + L2–L7 quota tiers).
 *
 * The L1–L7 axis is a *lifecycle* axis, not a scoring factor: two providers
 * with identical health/latency scores can still differ entirely in whether
 * the router is allowed to touch them. This module answers that question.
 *
 *   l1  concurrent race pool   — never rationed; capped by concurrency only
 *   l2  5-hour window          — codex/ollama-cloud style rolling window
 *   l3  daily window
 *   l4  weekly window          — often a companion window next to l2
 *   l5  monthly window
 *   l6  limited-time one-shot  — must be drained before its deadline
 *   l7  permanent last resort  — no expiry; never reached first
 *
 * `isAdmitted` / `admittedClasses` decide access. `recordConsumption` feeds
 * the counters from actual usage; `updateRemaining` ingests upstream-reported
 * remaining (rate-limit headers). `rankQuotaCandidates` orders a mixed-class
 * candidate pool so the router prefers scarce windows and burns l6 before it
 * expires instead of leaving it to waste.
 *
 * PURE and in-memory: module-level state only (no network, no DB, no timers),
 * mirroring the `advisorQuota.ts` convention. Tier defaults are wired in
 * `autoScoring.ts`; the gate trusts whoever registers a provider into a class.
 */
import { routeLog } from './stageLog.js'

export type QuotaClass = 'l1' | 'l2' | 'l3' | 'l4' | 'l5' | 'l6' | 'l7'

export const QUOTA_CLASSES: readonly QuotaClass[] = [
  'l1',
  'l2',
  'l3',
  'l4',
  'l5',
  'l6',
  'l7',
] as const

/** Window label per tier. l2 is '5h', not '5h/1w': codex / ollama-cloud carry
 *  a weekly companion window on top of the 5h one, which is l4 — a separate
 *  class, not a second label on the same one. */
export const QUOTA_TIER_WINDOW: Record<QuotaClass, string> = {
  l1: 'race',
  l2: '5h',
  l3: 'daily',
  l4: 'weekly',
  l5: 'monthly',
  l6: 'once',
  l7: 'permanent',
}

export interface QuotaGateConfig {
  /** Remaining percent at or above which a provider stays admitted. Default 10. */
  floorPercent?: number
  /** One-shot credits for l6 providers without an explicit window. Default 1. */
  onceLimit?: number
  /** Age after which a stale window is dropped so it can refill. Default 6h. */
  windowTtlMs?: number
  /** Allow requests when the class is unknown. Default true (fail open). */
  lenient?: boolean
}

export interface QuotaGateProviderState {
  className: QuotaClass | string
  remainingPercent: number
  admitted: boolean
  exhausted: boolean
}

export interface QuotaGateCandidate {
  provider: string
  model?: string
  className?: QuotaClass
  /** Optional upstream deadline for a limited-time credential. */
  expiresAt?: number
  /** Optional local usage counter for l6 providers. */
  usageCount?: number
}

export interface QuotaGateSnapshot {
  windows: Record<string, Partial<Record<QuotaClass, number>>>
  exhausted: Partial<Record<QuotaClass, number>>
  consumedOnce: Record<string, number>
}

const DEFAULT_FLOOR_PERCENT = 10
const DEFAULT_ONCE_LIMIT = 1
const DEFAULT_WINDOW_TTL_MS = 6 * 60 * 60 * 1000
const DEFAULT_DRAIN_HORIZON_MS = 24 * 60 * 60 * 1000

type QuotaWindow = {
  remainingPercent: number
  resetsAt: number
  expiresAt?: number
}

const windows = new Map<string, QuotaWindow[]>()
const consumedOnce = new Map<string, number>()
const exhaustedByClass = new Map<QuotaClass, number>()

function normalizeConfig(config: QuotaGateConfig): Required<QuotaGateConfig> {
  return {
    floorPercent: DEFAULT_FLOOR_PERCENT,
    onceLimit: DEFAULT_ONCE_LIMIT,
    windowTtlMs: DEFAULT_WINDOW_TTL_MS,
    lenient: true,
    ...config,
  }
}

function windowKey(provider: string, className: QuotaClass): string {
  return `${provider}|${className}`
}

function readClass(provider: string, className: QuotaClass): QuotaWindow[] {
  return windows.get(windowKey(provider, className)) ?? []
}

function classOf(label: string): QuotaClass | null {
  const direct = QUOTA_CLASSES.find(c => c === label)
  if (direct) return direct
  return (
    (Object.keys(QUOTA_TIER_WINDOW) as QuotaClass[]).find(
      c => QUOTA_TIER_WINDOW[c] === label,
    ) ?? null
  )
}

function nowMs(): number {
  return Date.now()
}

/** A window counts as live while its reset time is still in the future, or
 *  while the reset happened recently enough that upstream hasn't actually
 *  refilled yet (TTL guard). Once the reset time has passed and the TTL is
 *  exceeded the window is dropped entirely, so the next update starts fresh. */
function isWindowLive(
  window: QuotaWindow,
  cfg: Required<QuotaGateConfig>,
  now: number,
): boolean {
  if (window.resetsAt <= 0) return true
  if (window.resetsAt > now) return true
  return now - window.resetsAt <= cfg.windowTtlMs
}

function liveWindow(
  provider: string,
  className: QuotaClass,
  cfg: Required<QuotaGateConfig>,
  now: number,
): QuotaWindow | null {
  return (
    readClass(provider, className).find(w => isWindowLive(w, cfg, now)) ?? null
  )
}

function countExhausted(className: QuotaClass): number {
  return exhaustedByClass.get(className) ?? 0
}

/** Effective remaining percent for a class at `now`. A window whose reset
 *  time has already passed is treated as refilled (100), because upstream
 *  refreshes its budget at that instant. */
function remainingFromWindow(
  provider: string,
  className: QuotaClass,
  cfg: Required<QuotaGateConfig>,
  now: number,
): number {
  const window = liveWindow(provider, className, cfg, now)
  if (!window) return 100
  if (window.resetsAt > 0 && window.resetsAt <= now) return 100
  return window.remainingPercent
}

function markExhausted(className: QuotaClass): void {
  exhaustedByClass.set(className, countExhausted(className) + 1)
}

/**
 * Decide whether `provider` may be routed into `className` right now.
 *
 * Race (l1) and permanent (l7) are never rationed — capped by concurrency and
 * by last-resort policy respectively, not by quota. Unknown classes fail open
 * by default: a wrong label must not silently kill a working provider.
 */
export function isAdmitted(
  provider: string,
  className: QuotaClass | string = 'l1',
  config: QuotaGateConfig = {},
  now = nowMs(),
): QuotaGateProviderState {
  const cfg = normalizeConfig(config)
  const resolved = classOf(className)
  if (!resolved) {
    routeLog(
      'pick',
      `quota gate unknown class ${className} → admitted=${cfg.lenient}`,
    )
    return {
      className,
      remainingPercent: 100,
      admitted: cfg.lenient,
      exhausted: false,
    }
  }
  if (resolved === 'l1' || resolved === 'l7') {
    return {
      className: resolved,
      remainingPercent: 100,
      admitted: true,
      exhausted: false,
    }
  }

  if (resolved === 'l6') {
    const used = consumedOnce.get(provider) ?? 0
    const drained = used >= cfg.onceLimit
    return {
      className: resolved,
      remainingPercent: drained ? 0 : 100,
      admitted: !drained,
      exhausted: drained,
    }
  }

  const remaining = remainingFromWindow(provider, resolved, cfg, now)
  const exhausted = remaining < cfg.floorPercent
  return {
    className: resolved,
    remainingPercent: remaining,
    admitted: !exhausted,
    exhausted,
  }
}

/** Which quota classes a provider can still serve — drives escalation order. */
export function admittedClasses(
  provider: string,
  config: QuotaGateConfig = {},
  now = nowMs(),
): QuotaClass[] {
  return QUOTA_CLASSES.filter(
    className => isAdmitted(provider, className, config, now).admitted,
  )
}

/**
 * Order a mixed-class candidate pool for the router.
 *
 * 1. Scarce windows rank highest — drain a 5h/week/month budget while it is
 *    still usable rather than idling a fresh one on top of an exhausted one.
 * 2. l6 (limited-time one-shot) is pushed to the front when its deadline is
 *    inside the drain horizon, so it is consumed before it becomes waste.
 * 3. l7 (permanent) is deferred until the pool is actually exhausted, so paid
 *    or otherwise precious credentials are never burned as a first hop.
 */
export function rankQuotaCandidates(
  candidates: QuotaGateCandidate[],
  config: QuotaGateConfig = {},
  now = nowMs(),
  drainHorizonMs = DEFAULT_DRAIN_HORIZON_MS,
): QuotaGateCandidate[] {
  const cfg = normalizeConfig(config)
  const permanentExhausted = countExhausted('l7') > 0
  const poolExhausted =
    candidates.length > 0 &&
    candidates.every(candidate => (candidate.className ?? 'l1') === 'l7')

  const ranked = candidates.map((candidate, index) => {
    const className = candidate.className ?? 'l1'
    const state = isAdmitted(candidate.provider, className, cfg, now)
    const urgency = l6Urgency(candidate, className, now, drainHorizonMs)
    const defer = className === 'l7' && !poolExhausted && !permanentExhausted
    const score =
      urgency * 10000 +
      (state.admitted ? state.remainingPercent : -10000) -
      (defer ? 5000 : 0) +
      (1 - index / Math.max(1, candidates.length - 1)) * 100
    return { candidate, score }
  })
  ranked.sort((a, b) => b.score - a.score)
  return ranked.map(entry => entry.candidate)
}

/** Record real usage so the next gate decision reflects it. */
export function recordConsumption(
  provider: string,
  className: QuotaClass,
  usedPercent: number,
  config: QuotaGateConfig = {},
  now = nowMs(),
): void {
  const cfg = normalizeConfig(config)
  if (usedPercent <= 0) return

  if (className === 'l6') {
    consumedOnce.set(provider, (consumedOnce.get(provider) ?? 0) + usedPercent)
    if ((consumedOnce.get(provider) ?? 0) >= cfg.onceLimit) {
      markExhausted('l6')
    }
    return
  }
  if (className === 'l1' || className === 'l7') return

  const key = windowKey(provider, className)
  const current = readClass(provider, className)
  const window = liveWindow(provider, className, cfg, now)
  if (window) {
    window.remainingPercent = clampPercent(
      window.remainingPercent - usedPercent,
    )
    if (window.remainingPercent < cfg.floorPercent) markExhausted(className)
  } else {
    current.push({
      remainingPercent: clampPercent(100 - usedPercent),
      resetsAt: now + cfg.windowTtlMs,
    })
    if (100 - usedPercent < cfg.floorPercent) markExhausted(className)
  }
  windows.set(key, current)
}

/** Ingest upstream-reported remaining percent (rate-limit headers, etc.). */
export function updateRemaining(
  provider: string,
  className: QuotaClass,
  remainingPercent: number,
  resetAt?: number,
  config: QuotaGateConfig = {},
  now = nowMs(),
): void {
  const cfg = normalizeConfig(config)
  if (className === 'l1' || className === 'l7') return

  const key = windowKey(provider, className)
  const current = readClass(provider, className)
  const window = liveWindow(provider, className, cfg, now)
  const value = clampPercent(remainingPercent)
  if (window) {
    window.remainingPercent = value
    if (typeof resetAt === 'number' && resetAt > 0) window.resetsAt = resetAt
    if (value < cfg.floorPercent) markExhausted(className)
  } else {
    current.push({
      remainingPercent: value,
      resetsAt:
        typeof resetAt === 'number' && resetAt > 0
          ? resetAt
          : now + cfg.windowTtlMs,
    })
    if (value < cfg.floorPercent) markExhausted(className)
  }
  windows.set(key, current)
}

/** Reset all gate state (test helper). */
export function resetQuotaGate(): void {
  windows.clear()
  consumedOnce.clear()
  exhaustedByClass.clear()
}

/** Debug snapshot of the gate state. */
export function snapshotQuotaGate(): QuotaGateSnapshot {
  const windowsOut: Record<string, Partial<Record<QuotaClass, number>>> = {}
  for (const [key, byClass] of windows) {
    const [provider, className] = key.split('|') as [string, QuotaClass]
    const bucket = windowsOut[provider] ?? {}
    for (const window of byClass) {
      bucket[className] = window.remainingPercent
    }
    windowsOut[provider] = bucket
  }
  const exhaustedOut: Partial<Record<QuotaClass, number>> = {}
  for (const [className, count] of exhaustedByClass) {
    exhaustedOut[className] = count
  }
  const consumedOut: Record<string, number> = {}
  for (const [provider, count] of consumedOnce) {
    consumedOut[provider] = count
  }
  return {
    windows: windowsOut,
    exhausted: exhaustedOut,
    consumedOnce: consumedOut,
  }
}

/** Urgency multiplier for l6 credentials: 0 when the deadline is far, 1 when
 *  it is imminent, -1 once it has already passed. */
function l6Urgency(
  candidate: QuotaGateCandidate,
  className: QuotaClass,
  now: number,
  drainHorizonMs: number,
): number {
  if (className !== 'l6') return 0
  if (typeof candidate.expiresAt === 'number') {
    const left = candidate.expiresAt - now
    if (left <= 0) return -1
    return Math.max(0, Math.min(1, 1 - left / drainHorizonMs))
  }
  return Math.max(0, Math.min(1, 0.5 - (candidate.usageCount ?? 0) / 100))
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(100, Math.max(0, value))
}
