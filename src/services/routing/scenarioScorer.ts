/**
 * Deep multi-factor scenario scorer.
 *
 * Extracts a Scenario from CCB's native interaction context (code edit,
 * code generation, unit-test debugging, long-context analysis, chat, bug
 * review), combines PG-sourced static weights and model capabilities with
 * Redis-sourced dynamic signals (latency, health, quota, 429 cooldown,
 * rate counters, hot-model tag), and picks the single best upstream.
 *
 * No chained fallback — one winner, direct OpenAI-compatible send.
 */

import {
  type ModelCapabilityView,
  loadCapabilitiesFromPG,
  loadScenarioRulesFromPG,
  loadProvidersFromPG,
  type ScenarioRuleView,
} from '../providerRegistry/pgLoader.js'
import {
  readRuntimeSignalsBatch,
  type RuntimeSignalBundle,
} from './runtimeSignals.js'

export type ScenarioId =
  | 'code_edit'
  | 'code_generate'
  | 'unit_test'
  | 'long_context'
  | 'chat'
  | 'bug_review'
  | 'fallback'

export interface ScenarioContext {
  id: ScenarioId
  tokenBudget: number
  wantsReasoning: boolean
  wantsVision: boolean
  wantsTools: boolean
  wantsLongContext: boolean
  promptHint?: string
}

export interface CandidateView {
  providerId: string
  modelId: string
  candidate: string
  baseUrl: string
  apiKey: string
  accountId?: string
  headers?: Record<string, string>
  timeoutMs?: number
  compatRule?: string
}

export interface ScoredPick {
  candidate: CandidateView
  scenario: ScenarioContext
  score: number
  factors: ScoringBreakdown
  signals: RuntimeSignalBundle
  capability: ModelCapabilityView | null
  chosenReason: string
}

export interface ScoringBreakdown {
  staticWeight: number
  capabilityFit: number
  contextFit: number
  latencyInv: number
  health: number
  quota: number
  ruleBoost: number
  scenarioBias: number
  cooldownPenalty: number
  errorPenalty: number
}

const WEIGHT_TABLE: Record<ScenarioId, ScoringWeightsShape> = {
  code_edit: {
    staticWeight: 0.2,
    capabilityFit: 0.3,
    contextFit: 0.1,
    latencyInv: 0.1,
    health: 0.15,
    quota: 0.05,
    ruleBoost: 0.05,
    scenarioBias: 0.05,
    cooldownPenalty: 0,
    errorPenalty: 0,
  },
  code_generate: {
    staticWeight: 0.15,
    capabilityFit: 0.35,
    contextFit: 0.05,
    latencyInv: 0.15,
    health: 0.1,
    quota: 0.05,
    ruleBoost: 0.05,
    scenarioBias: 0.05,
    cooldownPenalty: 0,
    errorPenalty: 0,
  },
  unit_test: {
    staticWeight: 0.1,
    capabilityFit: 0.3,
    contextFit: 0.1,
    latencyInv: 0.25,
    health: 0.1,
    quota: 0.05,
    ruleBoost: 0.05,
    scenarioBias: 0.05,
    cooldownPenalty: 0,
    errorPenalty: 0,
  },
  long_context: {
    staticWeight: 0.1,
    capabilityFit: 0.3,
    contextFit: 0.35,
    latencyInv: 0.05,
    health: 0.1,
    quota: 0.05,
    ruleBoost: 0.05,
    scenarioBias: 0,
    cooldownPenalty: 0,
    errorPenalty: 0,
  },
  chat: {
    staticWeight: 0.1,
    capabilityFit: 0.15,
    contextFit: 0.1,
    latencyInv: 0.3,
    health: 0.15,
    quota: 0.05,
    ruleBoost: 0.05,
    scenarioBias: 0.05,
    cooldownPenalty: 0,
    errorPenalty: 0,
  },
  bug_review: {
    staticWeight: 0.15,
    capabilityFit: 0.35,
    contextFit: 0.15,
    latencyInv: 0.05,
    health: 0.1,
    quota: 0.05,
    ruleBoost: 0.05,
    scenarioBias: 0.05,
    cooldownPenalty: 0,
    errorPenalty: 0,
  },
  fallback: {
    staticWeight: 0.15,
    capabilityFit: 0.3,
    contextFit: 0.1,
    latencyInv: 0.15,
    health: 0.15,
    quota: 0.05,
    ruleBoost: 0.05,
    scenarioBias: 0.05,
    cooldownPenalty: 0,
    errorPenalty: 0,
  },
}

interface ScoringWeightsShape {
  staticWeight: number
  capabilityFit: number
  contextFit: number
  latencyInv: number
  health: number
  quota: number
  ruleBoost: number
  scenarioBias: number
  cooldownPenalty: number
  errorPenalty: number
}

export function detectScenario(opts: {
  prompt?: string
  messageCount?: number
  hasFileEdits?: boolean
  hasTestFiles?: boolean
  hasBugs?: boolean
  wantsReasoning?: boolean
  wantsVision?: boolean
  wantsTools?: boolean
  wantsLongContext?: boolean
  tokenBudget?: number
}): ScenarioContext {
  const prompt = (opts.prompt ?? '').toLowerCase()
  const tokenBudget = Math.max(
    0,
    opts.tokenBudget ?? Math.max((opts.messageCount ?? 1) * 400, 8000),
  )
  const wantsLongContext = opts.wantsLongContext ?? tokenBudget >= 24000

  let id: ScenarioId = 'fallback'
  if (opts.hasBugs) id = 'bug_review'
  else if (
    opts.hasTestFiles ||
    /\b(test|spec|vitest|jest|pytest|unittest)\b/i.test(prompt)
  )
    id = 'unit_test'
  else if (
    opts.hasFileEdits ||
    /\b(edit|fix|patch|refactor|implement|add|create|write|change|update|modify|build|coding)\b/i.test(
      prompt,
    )
  )
    id = 'code_edit'
  else if (/^generate\b|^write\b|generate a|write a|create a/i.test(prompt))
    id = 'code_generate'
  else if (wantsLongContext || tokenBudget >= 32000) id = 'long_context'
  else id = 'chat'

  return {
    id,
    tokenBudget,
    wantsReasoning: opts.wantsReasoning ?? false,
    wantsVision: opts.wantsVision ?? false,
    wantsTools: opts.wantsTools ?? false,
    wantsLongContext,
    promptHint: opts.prompt,
  }
}

export async function scoreAndPick(
  candidates: CandidateView[],
  scenario: ScenarioContext,
): Promise<ScoredPick | null> {
  if (!candidates.length) return null
  const [capsMap, rules, providers] = await Promise.all([
    loadCapabilitiesFromPG(),
    loadScenarioRulesFromPG(),
    loadProvidersFromPG(),
  ])
  const providerStatic = new Map<string, number>(
    providers.map(p => [
      p.id,
      (p.compatRule ?? '') === 'permissive' ? 0.5 : 0.6,
    ]),
  )
  const weights = WEIGHT_TABLE[scenario.id] ?? WEIGHT_TABLE.fallback
  const batch = await readRuntimeSignalsBatch(
    candidates.map(c => ({ provider: c.providerId, model: c.modelId })),
  )

  const ranked = candidates
    .map(candidate => {
      const key = `${candidate.providerId}/${candidate.modelId}`
      const signals = batch.signals.get(key) ?? neutralSignals()
      const capability = capsMap[key] ?? capsMap[candidate.modelId] ?? null
      const factor = computeFactor(
        candidate,
        scenario,
        signals,
        capability,
        providerStatic.get(candidate.providerId) ?? 0.5,
        rules,
      )
      const total = clamp01(
        weights.staticWeight * factor.staticWeight +
          weights.capabilityFit * factor.capabilityFit +
          weights.contextFit * factor.contextFit +
          weights.latencyInv * factor.latencyInv +
          weights.health * factor.health +
          weights.quota * factor.quota +
          weights.ruleBoost * factor.ruleBoost +
          weights.scenarioBias * factor.scenarioBias,
      )
      const cooldownPenalty = signals.inCooldown ? 1 : 0
      const finalScore = total * (1 - cooldownPenalty)
      return {
        candidate,
        scenario,
        score: finalScore,
        factors: factor,
        signals,
        capability,
        chosenReason: '',
      }
    })
    .filter(pick => pick.score > 0)
    .sort((a, b) => b.score - a.score)

  const winner = ranked[0]
  if (!winner) return null
  winner.chosenReason = summarizeReason(winner, weights, scenario.id)
  return winner
}

function computeFactor(
  candidate: CandidateView,
  scenario: ScenarioContext,
  signals: RuntimeSignalBundle,
  capability: ModelCapabilityView | null,
  providerStatic: number,
  rules: ScenarioRuleView[],
): ScoringBreakdown {
  const capabilityFit = capability
    ? clamp01(
        0.35 +
          (scenario.wantsReasoning && capability.supportsReasoning
            ? 0.2
            : -0.15) +
          (scenario.wantsTools && capability.supportsTools ? 0.2 : -0.1) +
          (scenario.wantsVision && capability.supportsVision ? 0.15 : 0) +
          (capability.tier >= 3 ? 0.1 : 0),
      )
    : 0.4

  const ctx = capability?.realContext ?? 0
  const contextFit =
    ctx > 0 ? clamp01(Math.min(1, Math.log2(Math.max(1, ctx / 4000)) / 5)) : 0.4

  const latency = signals.latencyMs ?? 0
  const latencyInv = clamp01(1 - latency / 8000)

  const health = signals.health ?? 0.5
  const quota = signals.quota == null ? 1 : clamp01(signals.quota / 100)

  const ruleBoost = clamp01(
    rules
      .filter(r => r.enabled && r.scenario === scenario.id)
      .filter(r => matchesPattern(r.providerPattern, candidate.providerId))
      .filter(r => matchesPattern(r.modelPattern, candidate.modelId))
      .reduce((acc, r) => acc + r.weight * 0.05, 0),
  )

  const scenarioBias = computeScenarioBias(candidate, scenario, capability)

  const errorPenalty = signals.inCooldown ? 0.5 : 0

  return {
    staticWeight: clamp01(providerStatic),
    capabilityFit,
    contextFit,
    latencyInv,
    health,
    quota,
    ruleBoost,
    scenarioBias,
    cooldownPenalty: 0,
    errorPenalty,
  }
}

function computeScenarioBias(
  candidate: CandidateView,
  scenario: ScenarioContext,
  capability: ModelCapabilityView | null,
): number {
  const full = `${candidate.providerId}/${candidate.modelId}`.toLowerCase()
  const tokenBudget = scenario.tokenBudget || 0

  // 杀鸡不用牛刀，杀牛不用鸡刀：多因素感知上下文预算与推理需求
  const isSmallTask = tokenBudget <= 8000 && !scenario.wantsReasoning
  const isHeavyTask = tokenBudget >= 32000 || scenario.wantsReasoning

  switch (scenario.id) {
    case 'code_edit':
    case 'code_generate': {
      let bias = 0
      if (isHeavyTask) {
        // 重大任务 / 复杂代码生成：优先保证智力上限
        if (/(luna-pro|deepseek-v4-pro|ultra-550b|opus)/.test(full))
          bias += 0.25
        else if (/(luna|terra|claude|glm-5)/.test(full)) bias += 0.15
        else if (/(flash-lite|space-bunny)/.test(full)) bias -= 0.1
      } else if (isSmallTask) {
        // 小任务 / 机械代码操作：优先走零成本高吞吐池
        if (/(lightning|super-120b|space-bunny|flash-lite|laguna)/.test(full))
          bias += 0.25
        else if (/(luna-pro|ultra-550b)/.test(full)) bias -= 0.15
      } else {
        if (/(nemotron|glm|deepseek|qwen|sensenova|space-bunny)/.test(full))
          bias += 0.15
      }
      return clamp01(bias)
    }
    case 'unit_test': {
      let bias = 0
      if (/(flash|lite|fast|groq|cerebras|lightning|laguna)/.test(full))
        bias += 0.2
      if (isSmallTask && /(space-bunny|flash-lite)/.test(full)) bias += 0.15
      return clamp01(bias)
    }
    case 'long_context': {
      let bias = 0
      if ((capability?.realContext ?? 0) >= 128_000) bias += 0.2
      if (/(1m|128k|luna|terra|sensenova|deepseek)/.test(full)) bias += 0.15
      return clamp01(bias)
    }
    case 'chat': {
      let bias = 0
      // chat-pool: P0 SenseNova 6.8 Flash / GLM-4.7 / Qwen / Codex Terra
      if (
        /(sensenova-6\.8-flash|glm-4\.7|deepseek-v4-flash|gpt-5\.6-terra|qwen)/.test(
          full,
        )
      )
        bias += 0.25
      else if (/(lightning|super|space-bunny)/.test(full)) bias += 0.12
      else if (/(luna-pro|ultra-550b)/.test(full)) bias -= 0.1
      return clamp01(bias)
    }
    case 'bug_review': {
      let bias = 0
      // review/advisor: P0 Codex Luna-Pro, DeepSeek-Pro, Nemotron Ultra 550b
      if (/(luna-pro|deepseek-v4-pro|ultra-550b|opus)/.test(full)) bias += 0.3
      else if (/(luna|terra|glm-5\.2|glm-5\.3)/.test(full)) bias += 0.15
      else if (/(flash-lite|space-bunny|lightning)/.test(full)) bias -= 0.15
      return clamp01(bias)
    }
    default:
      return 0
  }
}

function matchesPattern(pattern: string, value: string): boolean {
  if (!pattern || pattern === '*') return true
  const rx = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  try {
    return new RegExp(`^${rx}$`, 'i').test(value)
  } catch {
    return false
  }
}

function summarizeReason(
  pick: {
    candidate: CandidateView
    factors: ScoringBreakdown
    capability: ModelCapabilityView | null
  },
  weights: ScoringWeightsShape,
  scenarioId: ScenarioId,
): string {
  const cap = pick.capability
  const parts = [
    `scenario=${scenarioId}`,
    `lat=${pick.factors.latencyInv.toFixed(2)}`,
    `health=${pick.factors.health.toFixed(2)}`,
    `ctx=${cap?.realContext ?? 0}`,
  ]
  if (pick.factors.ruleBoost > 0)
    parts.push(`ruleBoost=${pick.factors.ruleBoost.toFixed(2)}`)
  if (pick.factors.scenarioBias > 0)
    parts.push(`bias=${pick.factors.scenarioBias.toFixed(2)}`)
  if (weights.errorPenalty > 0)
    parts.push(`errPen=${pick.factors.errorPenalty.toFixed(2)}`)
  return `${pick.candidate.providerId}/${pick.candidate.modelId} (${parts.join(',')})`
}

function neutralSignals(): RuntimeSignalBundle {
  return {
    latencyMs: undefined,
    health: undefined,
    quota: undefined,
    inCooldown: false,
    requestCount: 0,
    isHot: false,
  }
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v))
}

export function candidatesFromProviders(
  providers: Array<{
    id: string
    baseUrl: string
    defaultModel?: string
    models?: string[]
    compatRule?: string
    accounts?: Array<{
      id?: string
      apiKey?: string
      model?: string
      enabled?: boolean
    }>
    timeoutMs?: number
    headers?: Record<string, string>
    noAuth?: boolean
    apiKey?: string
    apiKeyEnv?: string
  }>,
): CandidateView[] {
  const out: CandidateView[] = []
  const env = process.env
  for (const p of providers) {
    const models = new Set<string>()
    if (p.defaultModel) models.add(p.defaultModel)
    for (const m of p.models ?? []) if (m) models.add(m)
    for (const a of p.accounts ?? []) {
      if (a.enabled === false) continue
      if (a.model) models.add(a.model)
    }
    if (!models.size) continue
    const apiKeys = new Set<string>()
    if (p.apiKey) apiKeys.add(p.apiKey)
    if (p.apiKeyEnv) {
      const fromEnv = env[p.apiKeyEnv]
      if (fromEnv) apiKeys.add(fromEnv)
    }
    if (!p.noAuth) {
      for (const a of p.accounts ?? []) {
        if (a.apiKey) apiKeys.add(a.apiKey)
      }
    }
    for (const m of models) {
      for (const k of apiKeys.size ? apiKeys : ['']) {
        out.push({
          providerId: p.id,
          modelId: m,
          candidate: `${p.id}/${m}`,
          baseUrl: p.baseUrl.replace(/\/+$/, ''),
          apiKey: k,
          headers: p.headers,
          timeoutMs: p.timeoutMs,
          compatRule: p.compatRule,
        })
      }
    }
  }
  return out
}
