/**
 * Redis-backed runtime signals for the multi-factor scenario scorer.
 *
 * Key layout (all under `ccb:runtime:v1:` prefix — auto-applied by the client):
 *   latency:<provider>:<model>         — last measured latency (ms, string)
 *   latency:<provider>:<model>:ema    — EMA-smoothed latency (ms, string)
 *   health:<provider>:<model>          — 0..1 health score (string)
 *   health:<provider>                  — provider-level rollup (string)
 *   quota:<provider>:<model>           — remaining quota % (string)
 *   quota:<provider>                   — provider-level rollup (string)
 *   cool:<provider>:<account>          — 429 cooldown expiry (unix seconds)
 *   cool:<provider>                    — provider-level cooldown (unix seconds)
 *   rl:<provider>                      — rolling request count (int)
 *   hot:<provider>:<model>             — hot model cache tag (TTL)
 *   hb:<provider>:<model>              — heartbeat timestamp (unix seconds)
 *
 * Reads are best-effort: any Redis error yields "unknown" and the caller
 * treats the signal as neutral. Writes are fire-and-forget.
 */

import {
  redisGet,
  redisIncr,
  redisPipelined,
  redisPipelineResults,
} from '../redis/client.js'

export interface RuntimeSignalBundle {
  latencyMs: number | undefined
  health: number | undefined
  quota: number | undefined
  inCooldown: boolean
  requestCount: number
  isHot: boolean
}

const ALL_NEUTRAL: RuntimeSignalBundle = {
  latencyMs: undefined,
  health: undefined,
  quota: undefined,
  inCooldown: false,
  requestCount: 0,
  isHot: false,
}

function toNumber(v: unknown): number | undefined {
  if (v == null || v === '') return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}

/**
 * Fetch all dynamic signals for a candidate `provider/model`.
 * Uses one Redis pipeline roundtrip.
 */
export async function readRuntimeSignals(
  provider: string,
  model: string,
): Promise<RuntimeSignalBundle> {
  if (!provider) return ALL_NEUTRAL
  const ops: Array<[string, ...unknown[]]> = [
    ['get', `latency:${provider}:${model}`],
    ['get', `latency:${provider}:${model}:ema`],
    ['get', `health:${provider}:${model}`],
    ['get', `health:${provider}`],
    ['get', `quota:${provider}:${model}`],
    ['get', `quota:${provider}`],
    ['get', `cool:${provider}`],
    ['get', `rl:${provider}`],
    ['get', `hot:${provider}:${model}`],
  ]
  const results = await redisPipelineResults(ops)
  const latency = toNumber(results[1]) ?? toNumber(results[0])
  const health = toNumber(results[2]) ?? toNumber(results[3])
  const quota = toNumber(results[4]) ?? toNumber(results[5])
  const coolUntil = toNumber(results[6])
  const now = Math.floor(Date.now() / 1000)
  return {
    latencyMs: latency,
    health,
    quota,
    inCooldown: coolUntil != null && coolUntil > now,
    requestCount: toNumber(results[7]) ?? 0,
    isHot: asString(results[8]) !== null,
  }
}

export interface RuntimeSignalsBatch {
  signals: Map<string, RuntimeSignalBundle>
}

export async function readRuntimeSignalsBatch(
  candidates: Array<{ provider: string; model: string }>,
): Promise<RuntimeSignalsBatch> {
  const signals = new Map<string, RuntimeSignalBundle>()
  if (!candidates.length) return { signals }
  const ops: Array<[string, ...unknown[]]> = []
  const layout: Array<{
    provider: string
    model: string
    latencyIdx: number
    healthIdx: number
    quotaIdx: number
    coolIdx: number
  }> = []
  for (const { provider, model } of candidates) {
    layout.push({
      provider,
      model,
      latencyIdx: ops.length,
      healthIdx: ops.length + 1,
      quotaIdx: ops.length + 2,
      coolIdx: ops.length + 3,
    })
    ops.push(['get', `latency:${provider}:${model}:ema`])
    ops.push(['get', `health:${provider}:${model}`])
    ops.push(['get', `quota:${provider}`])
    ops.push(['get', `cool:${provider}`])
  }
  const results = await redisPipelineResults(ops)
  const now = Math.floor(Date.now() / 1000)
  for (const entry of layout) {
    const latency = toNumber(results[entry.latencyIdx])
    const health = toNumber(results[entry.healthIdx])
    const quota = toNumber(results[entry.quotaIdx])
    const coolUntil = toNumber(results[entry.coolIdx])
    signals.set(`${entry.provider}/${entry.model}`, {
      latencyMs: latency,
      health,
      quota,
      inCooldown: coolUntil != null && coolUntil > now,
      requestCount: 0,
      isHot: false,
    })
  }
  return { signals }
}

// ── Write helpers ──────────────────────────────────────────────────

export async function recordLatency(
  provider: string,
  model: string,
  latencyMs: number,
  windowSeconds = 300,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000)
  const prevEmaStr = await redisGet(`latency:${provider}:${model}:ema`)
  const prevEma = prevEmaStr ? Number(prevEmaStr) : latencyMs
  const ema = 0.3 * latencyMs + 0.7 * prevEma
  await redisPipelined([
    ['set', `latency:${provider}:${model}`, String(latencyMs)],
    ['expire', `latency:${provider}:${model}`, windowSeconds],
    ['set', `latency:${provider}:${model}:ema`, String(ema)],
    ['expire', `latency:${provider}:${model}:ema`, windowSeconds],
    ['set', `hb:${provider}:${model}`, String(now)],
    ['expire', `hb:${provider}:${model}`, windowSeconds],
  ])
}

export async function recordSuccess(
  provider: string,
  model: string,
  opts: { healthBump?: number; quotaRemaining?: number } = {},
): Promise<void> {
  const now = Math.floor(Date.now() / 1000)
  const windowSeconds = 600
  const prev = await redisGet(`health:${provider}:${model}`)
  const prevScore = prev ? Number(prev) : 0.5
  const next = clamp01(prevScore + (opts.healthBump ?? 0.02))
  const ops: Array<[string, ...unknown[]]> = [
    ['set', `health:${provider}:${model}`, String(next)],
    ['expire', `health:${provider}:${model}`, windowSeconds],
    ['set', `hb:${provider}:${model}`, String(now)],
    ['expire', `hb:${provider}:${model}`, windowSeconds],
    ['set', `hot:${provider}:${model}`, String(now)],
    ['expire', `hot:${provider}:${model}`, windowSeconds],
  ]
  if (opts.quotaRemaining != null && Number.isFinite(opts.quotaRemaining)) {
    ops.push(['set', `quota:${provider}:${model}`, String(opts.quotaRemaining)])
    ops.push(['expire', `quota:${provider}:${model}`, windowSeconds])
  }
  await redisPipelined(ops)
}

export async function recordRateLimit(
  provider: string,
  accountId: string | undefined,
  cooldownSeconds = 300,
): Promise<void> {
  const until = Math.floor(Date.now() / 1000) + cooldownSeconds
  const ops: Array<[string, ...unknown[]]> = [
    ['set', `cool:${provider}`, String(until)],
    ['expire', `cool:${provider}`, cooldownSeconds],
    ['set', `health:${provider}`, '0'],
    ['expire', `health:${provider}`, cooldownSeconds],
  ]
  if (accountId) {
    ops.push(['set', `cool:${provider}:${accountId}`, String(until)])
    ops.push(['expire', `cool:${provider}:${accountId}`, cooldownSeconds])
  }
  await redisPipelined(ops)
}

export async function recordFailure(
  provider: string,
  model: string,
  opts: { severity?: number; cooldownSeconds?: number } = {},
): Promise<void> {
  const severity = clamp01(opts.severity ?? 0.4)
  const cooldownSeconds = opts.cooldownSeconds ?? 60
  const windowSeconds = 600
  const prev = await redisGet(`health:${provider}:${model}`)
  const prevScore = prev ? Number(prev) : 0.5
  const next = clamp01(prevScore - severity * 0.3)
  const ops: Array<[string, ...unknown[]]> = [
    ['set', `health:${provider}:${model}`, String(next)],
    ['expire', `health:${provider}:${model}`, windowSeconds],
  ]
  if (severity >= 0.7) {
    const until = Math.floor(Date.now() / 1000) + cooldownSeconds
    ops.push(['set', `cool:${provider}`, String(until)])
    ops.push(['expire', `cool:${provider}`, cooldownSeconds])
  }
  await redisPipelined(ops)
}

export async function recordRequestStart(
  provider: string,
  windowSeconds = 60,
): Promise<number> {
  return (await redisIncr(`rl:${provider}`, windowSeconds)) ?? 0
}

export async function isProviderInCooldown(provider: string): Promise<boolean> {
  const coolUntil = await redisGet(`cool:${provider}`)
  if (coolUntil == null) return false
  const until = Number(coolUntil)
  if (!Number.isFinite(until)) return false
  return until > Math.floor(Date.now() / 1000)
}

export async function resolveCandidateSignal(
  candidate: string,
  localProbe: {
    health?: number
    latencyMs?: number
    quota?: number
  } = {},
): Promise<RuntimeSignalBundle> {
  const slash = candidate.indexOf('/')
  const provider = slash > 0 ? candidate.slice(0, slash) : candidate
  const model = slash > 0 ? candidate.slice(slash + 1) : ''
  const remote = await readRuntimeSignals(provider, model)
  return {
    latencyMs: remote.latencyMs ?? localProbe.latencyMs,
    health: remote.health ?? localProbe.health,
    quota: remote.quota ?? localProbe.quota,
    inCooldown: remote.inCooldown,
    requestCount: remote.requestCount,
    isHot: remote.isHot,
  }
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v))
}
