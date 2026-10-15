/** Auto-routing scoring engine, ported from OmniRoute's auto-combo scorer
 *  (open-sse/services/autoCombo/scoring.ts). Candidates are probed directly
 *  against their upstream providers (GET {baseUrl}/models, the same probe
 *  9router uses) — no local gateway dependency. Factors without live
 *  telemetry take neutral values so scoring degrades gracefully.
 *
 *  Dynamic relative algorithm upgrade: candidate capabilities and live
 *  heartbeat are read from PG (pgLoader) / Redis (runtimeSignals) first,
 *  before falling back to the legacy file-based probe snapshot. A
 *  subscription time-value coefficient (AGY 3.8 Flash / Codex 5.6 Luna)
 *  boosts subscription-bounded models while they are still healthy, so
 *  quota that would otherwise expire unused is consumed productively
 *  (二十四字心法：该用用，不该用不用，能嫖嫖，好好嫖，按其约束合理白嫖，
 *  拒绝铺张浪费，拒绝空转). */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { findProvider } from '../providerRegistry/loader.js'
import {
  chooseAccounts,
  getRaceMetricPreferences,
} from '../omniroute/adapter.js'
import { routeLog, routeError } from './stageLog.js'
import { fetchCodeBuddyQuota } from './usage/codebuddy.js'
import {
  loadCapabilitiesFromPG,
  type ModelCapabilityView,
} from '../providerRegistry/pgLoader.js'
import {
  readRuntimeSignalsBatch,
  type RuntimeSignalBundle,
} from './runtimeSignals.js'

/** CodeBuddy CN billing endpoint (mirrors 9router registry usage.url). */
const CODEBUDDY_QUOTA_URL =
  'https://copilot.tencent.com/v2/billing/meter/get-user-resource'

export interface ScoringWeights {
  quota: number
  health: number
  costInv: number
  latencyInv: number
  taskFit: number
  stability: number
  tierPriority: number
  tierAffinity: number
  specificityMatch: number
  contextAffinity: number
  cacheAffinity?: number
  resetWindowAffinity: number
  connectionDensity: number
  errorPenalty?: number
}

export interface ScoringFactors {
  quota: number
  health: number
  costInv: number
  latencyInv: number
  taskFit: number
  stability: number
  tierPriority: number
  tierAffinity: number
  specificityMatch: number
  contextAffinity: number
  cacheAffinity?: number
  resetWindowAffinity: number
  connectionDensity: number
  errorPenalty: number
}

export const DEFAULT_WEIGHTS: ScoringWeights = {
  quota: 0.13,
  health: 0.18,
  costInv: 0.13,
  latencyInv: 0.1,
  taskFit: 0.07,
  stability: 0.04,
  tierPriority: 0.04,
  tierAffinity: 0.04,
  specificityMatch: 0.04,
  contextAffinity: 0.04,
  cacheAffinity: 0,
  resetWindowAffinity: 0,
  connectionDensity: 0.04,
  errorPenalty: 0.15,
}

/**
 * 零硬编码动态服务发现池 (Zero-Hardcoding Dynamic Auto-Discovery Pool)
 * 拒绝硬编码任何具体模型字符串，100% 依赖上游动态端点与服务发现展开活模型！
 */
export const DEFAULT_AUTO_CANDIDATES = [
  'agentbox-gateway/auto',
]
const DEFAULT_AUTO_L2_CANDIDATES = [
  'sensenova/*',
  'nvidia/*',
  'codex-bridge/*',
  'cx/*',
]
const DEFAULT_AUTO_L3_CANDIDATES: string[] = []
const DEFAULT_AUTO_L4_CANDIDATES: string[] = []
const DEFAULT_AUTO_L5_CANDIDATES: string[] = []
const DEFAULT_AUTO_L6_CANDIDATES: string[] = []

/** A fresh process has no completion telemetry yet. Start with the local,
 * verified Gitee route instead of gambling a whole first turn on slower remote
 * fallbacks; live probe scores take over as soon as the snapshot is ready. */
const COLD_START_PROVIDER_ORDER = [
  'gitee',
  'opencode',
  'nvidia',
  'codebuddy-cn',
]

/** Candidate pool config file (ccb-owned, not 9router). Path overridable via
 *  CCB_AUTO_CANDIDATES_FILE. A JSON array of "provider/model" specs. Missing
 *  or invalid → null, so callers fall back to DEFAULT_AUTO_CANDIDATES. */
const AUTO_CANDIDATES_FILE =
  process.env.CCB_AUTO_CANDIDATES_FILE ??
  join(homedir(), '.ccb-embed', 'auto-candidates.json')
function getOpenCodeModelsCacheFile(): string {
  return (
    process.env.CCB_OPENCODE_MODELS_CACHE_FILE ??
    join(homedir(), '.ccb-embed', 'opencode-free-models.json')
  )
}
const OPENCODE_MODELS_CACHE_FILE = getOpenCodeModelsCacheFile()
const OPENCODE_MODELS_CACHE_TTL_MS = 24 * 60 * 60 * 1000
const OPENCODE_MODELS_URL =
  process.env.OPENCODE_ZEN_BASE_URL ?? 'https://opencode.ai/zen/v1'

/**
 * Models that are no longer free on OpenCode Zen and must never be raced or
 * fallback-routed. deepseek-v4-flash-free lost its free tier in 2026; keep
 * adding retired ids here so a stale cache can never resurrect them.
 */
const RETIRED_OPENCODE_MODELS = new Set(['deepseek-v4-flash-free'])

/** Filter a cache list down to genuinely-free models. Central guard so every
 *  candidate path (active_pool, L1 race, fallback) shares one retirement list. */
export function filterRetiredOpenCodeModels(models: string[]): string[] {
  return models.filter(model => !RETIRED_OPENCODE_MODELS.has(model))
}

type AutoCandidateTiers = {
  l1: string[]
  l2: string[]
  l3: string[]
  l4: string[]
  l5: string[]
  l6: string[]
}

/** Telemetry/refresh window label per tier, used for logging and escalation
 *  order. L1 is the concurrent race; L2–L6 are time-windowed scoring pools.
 *  Functional per-window score snapshots are a future enhancement. */
export const TIER_WINDOW: Record<keyof AutoCandidateTiers, string> = {
  l1: 'race',
  l2: '5h',
  l3: 'daily',
  l4: 'weekly',
  l5: 'monthly',
  l6: 'once',
}

type OpenCodeModelsCache = { updatedAt: string; models: string[] }

function candidateList(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .map(item => (typeof item === 'string' ? item.trim() : ''))
        .filter(Boolean)
    : []
}

/** Read the candidate pool from ccb's own config file. Returns null when the
 *  file is absent, malformed, or empty so the built-in default still applies. */
function readAutoCandidatesFile(): AutoCandidateTiers | null {
  try {
    if (!existsSync(AUTO_CANDIDATES_FILE)) return null
    const parsed = JSON.parse(
      readFileSync(AUTO_CANDIDATES_FILE, 'utf8'),
    ) as unknown
    if (Array.isArray(parsed)) {
      const l1 = candidateList(parsed)
      return l1.length ? { l1, l2: [], l3: [], l4: [], l5: [], l6: [] } : null
    }
    if (!parsed || typeof parsed !== 'object') return null
    const record = parsed as Record<string, unknown>
    const l1 = candidateList(record.l1)
    const l2 = candidateList(record.l2)
    const l3 = candidateList(record.l3)
    const l4 = candidateList(record.l4)
    const l5 = candidateList(record.l5)
    const l6 = candidateList(record.l6)
    return l1.length ||
      l2.length ||
      l3.length ||
      l4.length ||
      l5.length ||
      l6.length
      ? { l1, l2, l3, l4, l5, l6 }
      : null
  } catch (error) {
    routeError('probe', 'auto candidates file read failed', String(error))
    return null
  }
}

function readOpenCodeModelsCache(): OpenCodeModelsCache | undefined {
  try {
    const parsed = JSON.parse(
      readFileSync(getOpenCodeModelsCacheFile(), 'utf8'),
    ) as unknown
    if (!parsed || typeof parsed !== 'object') return undefined
    const record = parsed as Record<string, unknown>
    const updatedAt =
      typeof record.updatedAt === 'string' ? record.updatedAt : ''
    const models = candidateList(record.models)
    return updatedAt && models.length ? { updatedAt, models } : undefined
  } catch {
    return undefined
  }
}

function cachedOpenCodeModels(): string[] {
  // Never fall back to a hardcoded model: an empty cache means OpenCode simply
  // contributes no candidate, instead of silently reviving a retired id.
  return filterRetiredOpenCodeModels(readOpenCodeModelsCache()?.models ?? [])
}

/** Free OpenCode models currently available for racing. Returns an empty array
 *  when the cache is missing or stale, so directRacePool skips OpenCode instead
 *  of racing a hardcoded model the cache no longer vouches for. Retired models
 *  are dropped even when the cache still lists them. */
export function currentFreeOpenCodeModels(): string[] {
  const cache = readOpenCodeModelsCache()
  if (!cache) return []
  const updatedAt = Date.parse(cache.updatedAt)
  if (!Number.isFinite(updatedAt)) return []
  if (Date.now() - updatedAt >= OPENCODE_MODELS_CACHE_TTL_MS) return []
  return filterRetiredOpenCodeModels(cache.models)
}

export function invalidateOpenCodeModelsCache(): void {
  try {
    unlinkSync(OPENCODE_MODELS_CACHE_FILE)
  } catch {
    // No cache yet is already the desired state.
  }
}

function hasOpenCodeWildcard(): boolean {
  const raw = process.env.CCB_AUTO_CANDIDATES
  if (raw)
    return raw.split(',').some(candidate => candidate.trim() === 'opencode/*')
  const configured = readAutoCandidatesFile()
  return [...(configured?.l1 ?? []), ...(configured?.l2 ?? [])].includes(
    'opencode/*',
  )
}

function expandOpenCodeModels(candidates: string[]): string[] {
  const expanded = candidates.flatMap(candidate =>
    candidate === 'opencode/*'
      ? cachedOpenCodeModels().map(model => `opencode/${model}`)
      : candidate,
  )
  return filterOpenCodeCandidates(expanded)
}

/** Drop retired OpenCode models wherever they come from — wildcard expansion,
 *  env-var CCB_AUTO_CANDIDATES, or an explicit `opencode/<model>` entry. This
 *  is the final gate on the active_pool. */
export function filterOpenCodeCandidates(candidates: string[]): string[] {
  return candidates.filter(candidate => {
    const lower = candidate.toLowerCase().trim()
    if (lower.startsWith('opencode/')) {
      return !RETIRED_OPENCODE_MODELS.has(
        lower.slice('opencode/'.length).trim(),
      )
    }
    // Bare names may belong to other providers, but a bare retired id must not
    // survive either.
    return !RETIRED_OPENCODE_MODELS.has(lower)
  })
}

async function refreshOpenCodeModels(): Promise<void> {
  const cache = readOpenCodeModelsCache()
  const configured = readAutoCandidatesFile()
  const explicitlyMissing = [
    ...(configured?.l1 ?? []),
    ...(configured?.l2 ?? []),
  ].some(
    candidate =>
      candidate.startsWith('opencode/') &&
      candidate !== 'opencode/*' &&
      !cache?.models.includes(candidate.slice('opencode/'.length)),
  )
  const cacheIsFresh =
    cache &&
    Date.now() - Date.parse(cache.updatedAt) < OPENCODE_MODELS_CACHE_TTL_MS
  if (!hasOpenCodeWildcard() || (cacheIsFresh && !explicitlyMissing)) return
  try {
    const response = await fetch(`${OPENCODE_MODELS_URL}/models`, {
      headers: { 'x-opencode-client': 'desktop', Accept: 'application/json' },
    })
    const payload = (await response.json()) as { data?: unknown }
    const models = Array.isArray(payload.data)
      ? payload.data
          .map(item =>
            item && typeof item === 'object' && typeof item.id === 'string'
              ? item.id.trim()
              : '',
          )
          .filter(
            model =>
              Boolean(model) &&
              !/(?:image|video|audio|tts|transcri(?:be|ption)|embed)/i.test(
                model,
              ),
          )
          .filter(Boolean)
      : []
    if (!response.ok || !models.length)
      throw new Error(`OpenCode models returned HTTP ${response.status}`)
    writeFileSync(
      OPENCODE_MODELS_CACHE_FILE,
      `${JSON.stringify({ updatedAt: new Date().toISOString(), models })}\n`,
      { mode: 0o600 },
    )
    routeLog('candidates', `OpenCode models refreshed (${models.length})`)
  } catch (error) {
    routeLog('probe', `OpenCode models refresh failed: ${String(error)}`)
  }
}

/** Candidate pool resolution order:
 *  1. CCB_AUTO_CANDIDATES env (comma-separated) — highest priority, for tests.
 *  2. ccb-owned config file (auto-candidates.json) — JSON array, or {l1,l2}.
 *  3. DEFAULT_AUTO_CANDIDATES — built-in fallback when neither is set. */
// One-time log on first call — candidates list is stable per session.
let autoCandidatesLogged = false
export function getAutoCandidates(): string[] {
  const raw = process.env.CCB_AUTO_CANDIDATES
  const candidates = raw
    ? candidateList(raw.split(','))
    : [...DEFAULT_AUTO_CANDIDATES]
  const resolved = filterOpenCodeCandidates(
    expandOpenCodeModels(
      candidates.length ? candidates : [...DEFAULT_AUTO_CANDIDATES],
    ),
  )

  if (!autoCandidatesLogged) {
    // routeLog('candidates', 'active_pool', resolved.join(','))
    autoCandidatesLogged = true
  }
  return resolved
}

export function getAutoCandidateTiers(): AutoCandidateTiers {
  const all = getAutoCandidates()
  return {
    l1: all,
    l2: [],
    l3: [],
    l4: [],
    l5: [],
    l6: [],
  }
}

export function isAutoCandidate(model: string): boolean {
  return getAutoCandidates().includes(model)
}

function providerOf(candidate: string): string {
  const slash = candidate.indexOf('/')
  return slash > 0 ? candidate.slice(0, slash) : candidate
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

export function calculateScore(
  factors: ScoringFactors,
  weights: ScoringWeights,
): number {
  return clamp01(
    weights.quota * factors.quota +
      weights.health * factors.health +
      weights.costInv * factors.costInv +
      weights.latencyInv * factors.latencyInv +
      weights.taskFit * factors.taskFit +
      weights.stability * factors.stability +
      weights.tierPriority * factors.tierPriority +
      weights.tierAffinity * factors.tierAffinity +
      weights.specificityMatch * factors.specificityMatch +
      weights.contextAffinity * factors.contextAffinity +
      (weights.cacheAffinity ?? 0) * (factors.cacheAffinity ?? 0) +
      weights.resetWindowAffinity * factors.resetWindowAffinity +
      weights.connectionDensity * factors.connectionDensity +
      (weights.errorPenalty ?? 0) * (1 - factors.errorPenalty),
  )
}

/** Factors for one candidate. health/latencyInv/quota are the live probe
 *  signals; the rest are neutral so missing telemetry never distorts ordering.
 *  quota is a 0..100 remaining-percentage; missing → 1 (neutral, as OmniRoute's
 *  quota factor is clamp01(quotaRemaining/100)). */
export function calculateFactors(
  health: number | undefined,
  latencyInv: number | undefined,
  quota: number | undefined,
): ScoringFactors {
  return {
    quota: quota === undefined ? 1 : clamp01(quota / 100),
    health: health ?? 1,
    costInv: 0.5,
    latencyInv: latencyInv ?? 0.5,
    taskFit: 1,
    stability: 0.5,
    tierPriority: 0.5,
    tierAffinity: 0.5,
    specificityMatch: 0.5,
    contextAffinity: 0.5,
    cacheAffinity: 0.5,
    resetWindowAffinity: 0.5,
    connectionDensity: 0.5,
    errorPenalty: 0,
  }
}

export interface ScoredCandidate {
  candidate: string
  score: number
}

/** Small prompt-aware tie-breaker. Health, quota and recent race outcomes
 * remain dominant; this only decides who gets the race head start. */
function scenarioBias(candidate: string, prompt?: string): number {
  if (!prompt) return 0
  const text = prompt.toLowerCase()
  const quick = /(?:quick|fast|brief|short|简单|快速|尽快|一句)/.test(text)
  const complex =
    /(?:code|debug|refactor|architect|review|complex|编程|调试|重构|架构|审查|复杂)/.test(
      text,
    )
  const model = candidate.toLowerCase()
  if (quick) return /(?:flash|opencode|agnes)/.test(model) ? 0.08 : -0.02
  if (complex)
    return /(?:glm-5\.2|hy3|nemotron|laguna|m3)/.test(model) ? 0.08 : 0
  return 0
}

/** Synchronous scoring against the cached probe snapshot; ties keep the
 *  configured candidate order. */
export function scorePoolSync(
  candidates: string[],
  prompt?: string,
): ScoredCandidate[] {
  const { health, latency, quota } = getSnapshot()
  const preferences = getRaceMetricPreferences()
  const coldStart = health.size === 0 && latency.size === 0 && quota.size === 0
  const latencies = [...latency.values()].filter(
    (ms): ms is number => typeof ms === 'number' && ms > 0,
  )
  const maxLatency = latencies.length ? Math.max(...latencies) : 0
  const ranked = candidates
    .map(candidate => {
      const provider = providerOf(candidate)
      const providerLatency = latency.get(provider)
      const latencyInv =
        typeof providerLatency === 'number' && maxLatency > 0
          ? 1 - providerLatency / maxLatency
          : undefined
      return {
        candidate,
        score: clamp01(
          calculateScore(
            calculateFactors(
              health.get(provider),
              latencyInv,
              quota.get(provider),
            ),
            DEFAULT_WEIGHTS,
          ) +
            (preferences.get(candidate) ?? 0) +
            scenarioBias(candidate, prompt),
        ),
      }
    })
    .sort((a, b) => {
      if (!coldStart) return b.score - a.score
      if (prompt?.trim()) return b.score - a.score
      const priority = (candidate: string) => {
        const index = COLD_START_PROVIDER_ORDER.indexOf(providerOf(candidate))
        return index < 0 ? COLD_START_PROVIDER_ORDER.length : index
      }
      return priority(a.candidate) - priority(b.candidate) || b.score - a.score
    })
  ranked.forEach((r, i) =>
    routeLog('rank', `${i + 1} ${r.score.toFixed(3)} ${r.candidate}`),
  )
  return ranked
}

// --- Direct upstream probe snapshot (cached, fail-open) ---

const PROBE_TTL_MS = 30_000
const PROBE_TIMEOUT_MS = 3_000

interface ProviderProbe {
  providerId: string
  baseUrl: string
  apiKey: string
  headers?: Record<string, string>
}

let probeCache: {
  ts: number
  health: Map<string, number>
  latency: Map<string, number>
  quota: Map<string, number>
} | null = null
let probeRefresh: Promise<void> | undefined

function getSnapshot(): {
  health: Map<string, number>
  latency: Map<string, number>
  quota: Map<string, number>
} {
  const cache = probeCache
  if (cache && Date.now() - cache.ts < PROBE_TTL_MS) {
    return { health: cache.health, latency: cache.latency, quota: cache.quota }
  }
  return {
    health: new Map(),
    latency: new Map(),
    quota: new Map(),
  }
}

// --- Dynamic relative signals (PG + Redis, fail-open) ---
// 订阅时效价值系数：AGY 3.8 Flash 与 Codex 5.6 Luna 在健康水位下积极作为主力
// 高质量调度，杜绝到期清零浪费。系数在 [0, 1] 区间内，对订阅模型加分。
const SUBSCRIPTION_BOOST_CAP = 0.12
const SUBSCRIPTION_HEALTHY_THRESHOLD = 0.6

/** 订阅时效价值模型：返回 [0, 1] 的加分系数。
 *  - 订阅模型且健康水位达标 → 接近 1（积极用，避免浪费）
 *  - 订阅模型但健康水位差 → 接近 0（不强行用）
 *  - 非订阅模型 → 0
 *  调用方可乘以 SUBSCRIPTION_BOOST_CAP 转为实际加分值。 */
export function subscriptionTimeValue(
  candidate: string,
  health: number | undefined,
): number {
  const model = candidate.toLowerCase()
  const isSubscription =
    /(?:agy|codex|luna|3\.8\s*flash|5\.6\s*luna|chatgpt.*plus|claude.*pro)/.test(
      model,
    )
  if (!isSubscription) return 0
  const h = health ?? 0.5
  if (h < SUBSCRIPTION_HEALTHY_THRESHOLD) return 0
  // 健康水位越高，加分越大，最高 1
  return Math.min(
    1,
    (h - SUBSCRIPTION_HEALTHY_THRESHOLD) / (1 - SUBSCRIPTION_HEALTHY_THRESHOLD),
  )
}

/** 从 PG 加载 capabilities 与从 Redis 读取 runtime signals，merge 进 snapshot。
 *  返回 fail-open 的空 Map 当 PG / Redis 不可达。 */
async function enhanceSnapshotWithDynamicSignals(
  candidates: string[],
): Promise<{
  health: Map<string, number>
  latency: Map<string, number>
  quota: Map<string, number>
  capabilities: Record<string, ModelCapabilityView>
  signals: Map<string, RuntimeSignalBundle>
}> {
  const baseSnapshot = getSnapshot()
  const health = new Map(baseSnapshot.health)
  const latency = new Map(baseSnapshot.latency)
  const quota = new Map(baseSnapshot.quota)
  const capabilities: Record<string, ModelCapabilityView> = {}
  const signalsMap = new Map<string, RuntimeSignalBundle>()
  try {
    const capsFromPG = await loadCapabilitiesFromPG()
    for (const key of Object.keys(capsFromPG)) {
      capabilities[key] = capsFromPG[key]!
    }
  } catch (error) {
    routeError('probe', 'PG capability load failed', String(error))
  }
  try {
    const batch = await readRuntimeSignalsBatch(
      candidates.map(c => {
        const slash = c.indexOf('/')
        const provider = slash > 0 ? c.slice(0, slash) : c
        const model = slash > 0 ? c.slice(slash + 1) : ''
        return { provider, model }
      }),
    )
    for (const [key, signal] of batch.signals) {
      signalsMap.set(key, signal)
      // 把 Redis 的 health / latency / quota 覆盖进 snapshot（值更实时）
      const slash = key.lastIndexOf('/')
      const provider = slash > 0 ? key.slice(0, slash) : key
      if (typeof signal.health === 'number') {
        // PG/Redis 心跳优先：有值就覆盖
        health.set(provider, signal.health)
      }
      if (typeof signal.latencyMs === 'number') {
        const prevLat = latency.get(provider) ?? Number.POSITIVE_INFINITY
        latency.set(provider, Math.min(prevLat, signal.latencyMs))
      }
      if (typeof signal.quota === 'number') {
        const prevQuota = quota.get(provider) ?? 100
        // 保守取最小值：避免 drained 账号被当作 hot
        quota.set(provider, Math.min(prevQuota, signal.quota))
      }
    }
  } catch (error) {
    routeError('probe', 'Redis runtime signals read failed', String(error))
  }
  return { health, latency, quota, capabilities, signals: signalsMap }
}

/** 动态相对评分：先读 PG/Redis 心跳，再叠加订阅时效价值系数。
 *  当 PG/Redis 都不可达时退化为原 scorePoolSync 的行为。 */
export async function scorePoolDynamic(
  candidates: string[],
  prompt?: string,
): Promise<ScoredCandidate[]> {
  if (!candidates.length) return []
  const { health, latency, quota } =
    await enhanceSnapshotWithDynamicSignals(candidates)
  const preferences = getRaceMetricPreferences()
  const coldStart = health.size === 0 && latency.size === 0 && quota.size === 0
  const latencies = [...latency.values()].filter(
    (ms): ms is number => typeof ms === 'number' && ms > 0,
  )
  const maxLatency = latencies.length ? Math.max(...latencies) : 0
  const ranked = candidates
    .map(candidate => {
      const provider = providerOf(candidate)
      const providerLatency = latency.get(provider)
      const latencyInv =
        typeof providerLatency === 'number' && maxLatency > 0
          ? 1 - providerLatency / maxLatency
          : undefined
      const baseScore = calculateScore(
        calculateFactors(health.get(provider), latencyInv, quota.get(provider)),
        DEFAULT_WEIGHTS,
      )
      const subBoost =
        subscriptionTimeValue(candidate, health.get(provider)) *
        SUBSCRIPTION_BOOST_CAP
      return {
        candidate,
        score: clamp01(
          baseScore +
            (preferences.get(candidate) ?? 0) +
            scenarioBias(candidate, prompt) +
            subBoost,
        ),
      }
    })
    .sort((a, b) => {
      if (!coldStart) return b.score - a.score
      if (prompt?.trim()) return b.score - a.score
      const priority = (candidate: string) => {
        const index = COLD_START_PROVIDER_ORDER.indexOf(providerOf(candidate))
        return index < 0 ? COLD_START_PROVIDER_ORDER.length : index
      }
      return priority(a.candidate) - priority(b.candidate) || b.score - a.score
    })
  ranked.forEach((r, i) =>
    routeLog('rank', `${i + 1} ${r.score.toFixed(3)} ${r.candidate}`),
  )
  return ranked
}

/** Probe one provider's /models endpoint (same probe 9router's
 *  testApiKeyConnection uses). 401/403 → dead; 404/405 → endpoint unsupported
 *  (neutral, not a failure); ok → healthy with latency. */
async function probeProvider(
  probe: ProviderProbe,
): Promise<{ health: number; latencyMs: number } | undefined> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS)
  const start = Date.now()
  try {
    const res = await fetch(`${probe.baseUrl.replace(/\/$/, '')}/models`, {
      headers: {
        Authorization: `Bearer ${probe.apiKey}`,
        ...probe.headers,
      },
      signal: controller.signal,
    })
    const latencyMs = Date.now() - start
    if (res.ok) {
      routeLog(
        'probe',
        `${probe.providerId} ${probe.baseUrl} -> ${res.status} ${latencyMs}ms`,
      )
      return { health: 1, latencyMs }
    }
    if (res.status === 401 || res.status === 403) {
      routeLog(
        'probe',
        `${probe.providerId} ${probe.baseUrl} -> ${res.status} ${latencyMs}ms dead`,
      )
      return { health: 0, latencyMs }
    }
    routeLog(
      'probe',
      `${probe.providerId} ${probe.baseUrl} -> ${res.status} ${latencyMs}ms neutral`,
    )
    return undefined
  } catch (error) {
    routeLog(
      'probe',
      `${probe.providerId} ${probe.baseUrl} error ${String(error)}`,
    )
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

/** Warm the probe cache by testing each candidate's provider directly.
 *  Failures keep the prior snapshot (or none) — scoring degrades to neutral. */
export async function refreshAutoHealth(): Promise<void> {
  if (probeRefresh) return probeRefresh
  probeRefresh = refreshAutoHealthOnce().finally(() => {
    probeRefresh = undefined
  })
  return probeRefresh
}

async function refreshAutoHealthOnce(): Promise<void> {
  // Routing/health/quota belong to OmniRoute when server-side routing is on.
  // CCB remains a client; probing upstreams here duplicates traffic and can
  // disagree with the gateway's account/circuit state.
  if (process.env.OMNIROUTE_SERVER_ROUTING !== '0') {
    probeCache = {
      ts: Date.now(),
      health: new Map(),
      latency: new Map(),
      quota: new Map(),
    }
    routeLog('probe', 'refresh delegated to OmniRoute')
    return
  }
  await refreshOpenCodeModels()
  const probes = await buildProbes(getAutoCandidates())
  if (!probes.length) {
    routeLog('probe', 'refresh skipped (no probes resolvable)')
    return
  }
  const refreshStart = Date.now()
  const results = await Promise.allSettled(probes.map(probeProvider))
  // One provider may probe over multiple connections — keep the healthiest
  // result and the lowest latency so any live account makes the provider hot.
  const health = new Map<string, number>()
  const latency = new Map<string, number>()
  for (let i = 0; i < probes.length; i++) {
    const result = results[i]
    if (result.status !== 'fulfilled' || !result.value) continue
    const { providerId } = probes[i]
    const prev = health.get(providerId)
    health.set(
      providerId,
      prev === undefined
        ? result.value.health
        : Math.max(prev, result.value.health),
    )
    const prevLat = latency.get(providerId)
    latency.set(
      providerId,
      prevLat === undefined
        ? result.value.latencyMs
        : Math.min(prevLat, result.value.latencyMs),
    )
  }
  // CodeBuddy quota lives behind a separate billing endpoint; probe it for the
  // codebuddy connections in parallel. Multiple connections → keep the minimum
  // remaining (most conservative, so a drained account never looks hot).
  const codebuddyProvider = findProvider('codebuddy-cn')
  const codebuddyHeaders = codebuddyProvider?.headers
  const quota = new Map<string, number>()
  const quotaResults = await Promise.all(
    probes
      .filter(p => p.providerId === 'codebuddy-cn')
      .map(async p => {
        try {
          return {
            providerId: p.providerId,
            remaining: await fetchCodeBuddyQuota(
              codebuddyProvider?.usageUrl ?? CODEBUDDY_QUOTA_URL,
              p.apiKey,
              codebuddyHeaders,
            ),
          }
        } catch {
          return { providerId: p.providerId, remaining: undefined }
        }
      }),
  )
  for (const q of quotaResults) {
    if (q.remaining === undefined) continue
    const prev = quota.get(q.providerId)
    quota.set(
      q.providerId,
      prev === undefined ? q.remaining : Math.min(prev, q.remaining),
    )
  }
  if (quota.size > 0) {
    routeLog(
      'score',
      `quota codebuddy-cn=${[...quota.values()].map(q => `${q.toFixed(1)}%`).join(' | ')}`,
    )
  }
  probeCache = { ts: Date.now(), health, latency, quota }
  const snapshot = [...health.entries()]
    .map(([providerId, h]) => {
      const ms = latency.get(providerId)
      return `${providerId}=${h}${ms !== undefined ? `@${ms}ms` : ''}`
    })
    .join(' | ')
  routeLog(
    'probe',
    `refresh done in ${Date.now() - refreshStart}ms probes=${probes.length}`,
    snapshot,
  )
}

/** Resolve probe targets for the candidate providers. Unknown/custom
 *  providers (not in the registry) are skipped — neutral scores. */
async function buildProbes(candidates: string[]): Promise<ProviderProbe[]> {
  const seen = new Set<string>()
  const probes: ProviderProbe[] = []
  for (const candidate of candidates) {
    const providerId = providerOf(candidate)
    if (seen.has(providerId)) continue
    seen.add(providerId)
    if (providerId === 'opencode') {
      probes.push({
        providerId,
        baseUrl:
          process.env.OPENCODE_ZEN_BASE_URL ?? 'https://opencode.ai/zen/v1',
        apiKey: 'public',
        headers: {
          'x-opencode-client': 'desktop',
          Accept: 'text/event-stream',
        },
      })
      continue
    }
    const provider = findProvider(providerId)
    if (!provider) continue
    for (const account of chooseAccounts(provider)) {
      probes.push({
        providerId,
        baseUrl: provider.baseUrl,
        apiKey: account.apiKey,
        ...(provider.headers ? { headers: provider.headers } : {}),
      })
    }
  }
  return probes
}
