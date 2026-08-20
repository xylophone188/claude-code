/** Auto-routing scoring engine, ported from OmniRoute's auto-combo scorer
 *  (open-sse/services/autoCombo/scoring.ts). Candidates are probed directly
 *  against their upstream providers (GET {baseUrl}/models, the same probe
 *  9router uses) — no local gateway dependency. Factors without live
 *  telemetry take neutral values so scoring degrades gracefully. */
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

/** CodeBuddy CN billing endpoint (mirrors 9router registry usage.url). */
const CODEBUDDY_QUOTA_URL =
  'https://copilot.tencent.com/v2/billing/meter/get-user-resource'
/** A pack whose cycle end and validity end differ by more than 2 days is a
 *  recurring refill pack, not a one-shot bonus (ported from 9router). */
const CODEBUDDY_REFILL_GAP_MS = 2 * 24 * 60 * 60 * 1000
const CODEBUDDY_QUOTA_TIMEOUT_MS = 5_000

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

export const DEFAULT_AUTO_CANDIDATES = [
  'nvidia/z-ai/glm-5.2',
  'nvidia/poolside/laguna-xs-2.1',
  'nvidia/minimaxai/minimax-m3',
  'nvidia/nvidia/nemotron-3-ultra-550b-a55b',
  'nvidia/stepfun-ai/step-3.7-flash',
  'nvidia/google/gemma-4-31b-it',
  'nvidia/nvidia/nemotron-3-super-120b-a12b',
]
const DEFAULT_AUTO_L2_CANDIDATES = [
  'sensenova/sensenova-6.7-flash-lite',
  'sensenova/deepseek-v4-flash',
  'sensenova/glm-5.2',
  'nvidia/z-ai/glm-5.2',
]
// L3–L6 default pools mirror the providers already imported into
// ~/.ccb-embed/providers.json; the live auto-candidates.json overrides these.
const DEFAULT_AUTO_L3_CANDIDATES = [
  'cerebras/gpt-oss-120b',
  'groq/llama-3.3-70b-versatile',
  'cohere/command-a-03-2025',
  'mistral/mistral-large-latest',
  'aihorde/google/gemma-4-31b',
  'kimi/kimi-k3',
  'openrouter/nvidia/nemotron-3-super-120b-a12b:free',
]
const DEFAULT_AUTO_L4_CANDIDATES = [
  'openrouter/nvidia/nemotron-3-super-120b-a12b:free',
  'github',
  'kilocode',
  'kimchi',
  'api-airforce',
]
const DEFAULT_AUTO_L5_CANDIDATES = [
  'openai',
  'openrouter/nvidia/nemotron-3-super-120b-a12b:free',
]
const DEFAULT_AUTO_L6_CANDIDATES = [
  'ollama/llama3.1',
  'api-airforce',
  'kimchi',
  'kilocode',
]

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
const OPENCODE_MODELS_CACHE_FILE =
  process.env.CCB_OPENCODE_MODELS_CACHE_FILE ??
  join(homedir(), '.ccb-embed', 'opencode-free-models.json')
const OPENCODE_MODELS_CACHE_TTL_MS = 24 * 60 * 60 * 1000
const OPENCODE_MODELS_URL =
  process.env.OPENCODE_ZEN_BASE_URL ?? 'https://opencode.ai/zen/v1'
const FALLBACK_OPENCODE_MODEL = 'deepseek-v4-flash-free'

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
      readFileSync(OPENCODE_MODELS_CACHE_FILE, 'utf8'),
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
  return readOpenCodeModelsCache()?.models ?? [FALLBACK_OPENCODE_MODEL]
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
  return candidates.flatMap(candidate =>
    candidate === 'opencode/*'
      ? cachedOpenCodeModels().map(model => `opencode/${model}`)
      : candidate,
  )
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
              model.endsWith('-free') &&
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
export function getAutoCandidateTiers(): AutoCandidateTiers {
  const raw = process.env.CCB_AUTO_CANDIDATES
  if (raw) {
    const l1 = candidateList(raw.split(','))
    const tiers = {
      l1: l1.length ? l1 : DEFAULT_AUTO_CANDIDATES,
      l2: [],
      l3: [],
      l4: [],
      l5: [],
      l6: [],
    }
    if (!autoCandidatesLogged) {
      routeLog('candidates', 'candidates (env)', tiers.l1.join(','))
      autoCandidatesLogged = true
    }
    return {
      l1: expandOpenCodeModels(tiers.l1),
      l2: expandOpenCodeModels(tiers.l2),
      l3: expandOpenCodeModels(tiers.l3),
      l4: expandOpenCodeModels(tiers.l4),
      l5: expandOpenCodeModels(tiers.l5),
      l6: expandOpenCodeModels(tiers.l6),
    }
  }
  const fromFile = readAutoCandidatesFile()
  if (fromFile) {
    if (!autoCandidatesLogged) {
      routeLog(
        'candidates',
        'candidates (file)',
        `l1=${fromFile.l1.join(',')} l2=${fromFile.l2.join(',')} l3=${fromFile.l3.join(',')} l4=${fromFile.l4.join(',')} l5=${fromFile.l5.join(',')} l6=${fromFile.l6.join(',')}`,
      )
      autoCandidatesLogged = true
    }
    return {
      l1: expandOpenCodeModels(fromFile.l1),
      l2: expandOpenCodeModels(fromFile.l2),
      l3: expandOpenCodeModels(fromFile.l3),
      l4: expandOpenCodeModels(fromFile.l4),
      l5: expandOpenCodeModels(fromFile.l5),
      l6: expandOpenCodeModels(fromFile.l6),
    }
  }
  return {
    l1: DEFAULT_AUTO_CANDIDATES,
    l2: DEFAULT_AUTO_L2_CANDIDATES,
    l3: DEFAULT_AUTO_L3_CANDIDATES,
    l4: DEFAULT_AUTO_L4_CANDIDATES,
    l5: DEFAULT_AUTO_L5_CANDIDATES,
    l6: DEFAULT_AUTO_L6_CANDIDATES,
  }
}

export function getAutoCandidates(): string[] {
  const { l1, l2, l3, l4, l5, l6 } = getAutoCandidateTiers()
  return [...l1, ...l2, ...l3, ...l4, ...l5, ...l6]
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
