import { getAPIProvider } from './providers.js'

/**
 * Work package 1 — 唯一多因素选模 shadow receipt（最小垂直切片）。
 *
 * 定位：只记录今天**真实**选模路径做了什么，不新增任何 dispatch 决策。
 * - receipt 在既有决策之后构造，冻结，调用方可安全持有（不可变）。
 * - 已知场景只允许元数据：不写评分、不写因子值、不写选模建议。
 * - transport 侧不得因为本模块再次按 pool 私选模型。
 *
 * v8 合规红线：
 * - `default` 绝不等于 coding（coding 必须带显式 intent 元数据）。
 * - 无接线数据库、无伪造因子、无伪造排名。
 */

/** 已知场景。v8：default 不映射 coding。 */
export type Scenario = 'coding' | 'review' | 'agent' | 'subagent' | 'default'

export type TransportTag = 'direct' | 'legacy' | 'unknown'

type FactorShape =
  | { kind: 'string'; length: number }
  | { kind: 'boolean' }
  | { kind: 'number' }

export type MultifactorShadowReceipt = {
  schemaVersion: 1
  /** 场景 + 版本，如 `default@v1`。 */
  scenario: string
  /** 场景来源。 */
  scenarioOrigin: 'unknown' | 'default' | 'profile' | 'intent'
  profileVersion: string
  /** 因子版本 + 真实可观测快照（存在性/长度，非编造评分）。 */
  factors: {
    version: string
    status: 'snapshot' | 'unavailable'
    reason: string
    snapshot: Record<string, FactorShape>
  }
  /** 候选排名摘要。切片 1 只允许 legacy/unavailable。 */
  ranking: { status: 'legacy' | 'unavailable'; reason: string }
  /** legacy 路径实际选中的路由（今天的真实值）。 */
  legacySelectedRoute: {
    provider: string
    transport: TransportTag
    model: string
    hasApiKey: boolean
  }
  /** 旁路检测信号（v8 §2 信号清单）。 */
  bypassSignals: {
    envModelOverride: boolean
    envBaseUrlOverride: boolean
    envApiKeyOverride: boolean
    envModelMaxTokensOverride: boolean
    directUrlOverride: boolean
    legacyOnlyPath: boolean
    any: boolean
  }
}

export const SCENARIO_VERSION = 'v1'
export const PROFILE_VERSION = 'v1'
export const FACTOR_VERSION = 'snapshot@v1'
export const RECEIPT_SCHEMA_VERSION = 1 as const

const KNOWN_SCENARIOS: Scenario[] = [
  'coding',
  'review',
  'agent',
  'subagent',
  'default',
]

/**
 * v8：未知场景 → `default@v1`。
 * 只有携带显式 intent 的调用才能声明非 default 场景；
 * 因此 `default` 永远不会被当作 coding。
 */
export function scenarioForIntent(
  explicitScenario: string | undefined | null,
  hasExplicitIntent: boolean,
): { scenario: string; origin: 'unknown' | 'default' | 'profile' | 'intent' } {
  const normalized = explicitScenario?.trim().toLowerCase()
  if (normalized && KNOWN_SCENARIOS.includes(normalized as Scenario)) {
    if (normalized === 'default') {
      return { scenario: `default@${SCENARIO_VERSION}`, origin: 'default' }
    }
    if (hasExplicitIntent) {
      return {
        scenario: `${normalized}@${SCENARIO_VERSION}`,
        origin: 'intent',
      }
    }
  }
  return { scenario: `default@${SCENARIO_VERSION}`, origin: 'unknown' }
}

function shapeOf(value: unknown): FactorShape | undefined {
  if (typeof value === 'string') {
    return value ? { kind: 'string', length: value.length } : undefined
  }
  if (typeof value === 'boolean') return { kind: 'boolean' }
  if (typeof value === 'number' && Number.isFinite(value))
    return { kind: 'number' }
  return undefined
}

/** 真实可观测配置快照：只记形状/长度，密钥与 URL 内容不进 receipt。 */
function factorSnapshot(
  env: NodeJS.ProcessEnv,
): MultifactorShadowReceipt['factors'] {
  const candidates: Array<[string, unknown]> = [
    ['model', env.CLAUDE_CODE_MODEL],
    ['baseUrl', env.CLAUDE_CODE_BASE_URL ?? env.ANTHROPIC_BASE_URL],
    [
      'apiKey',
      env.CLAUDE_CODE_API_KEY ?? env.ANTHROPIC_API_KEY ?? env.OPENAI_API_KEY,
    ],
    ['modelMaxTokens', env.CLAUDE_CODE_MODEL_MAX_TOKENS],
    ['openaiModel', env.OPENAI_MODEL],
    ['openaiBaseUrl', env.OPENAI_BASE_URL],
  ]
  const snapshot: Record<string, FactorShape> = {}
  for (const [key, value] of candidates) {
    const shape = shapeOf(value)
    if (shape) snapshot[key] = shape
  }
  return {
    version: FACTOR_VERSION,
    status: 'snapshot',
    reason: 'observable env presence/length only; no scoring engine in slice 1',
    snapshot,
  }
}

/** 今天的 legacy 选模只处理这组别名 —— 有别名即 legacyOnlyPath。 */
const LEGACY_ALIASES = new Set(['opus', 'sonnet', 'haiku', 'auto', 'default'])

function isLegacyAlias(model: string): boolean {
  return (
    LEGACY_ALIASES.has(model) ||
    /(?:opus|sonnet|haiku|auto|default)\[1m\]/.test(model)
  )
}

/**
 * 构造 shadow receipt。纯函数，不改任何 dispatch 状态。
 */
export function buildMultifactorShadowReceipt(opts: {
  selectedModel: string
  provider: string
  transport?: TransportTag
  directUrl?: boolean
  explicitScenario?: string | null
  hasExplicitIntent?: boolean
  bypassLegacyOnly?: boolean
}): MultifactorShadowReceipt {
  const env = process.env
  const hasApiKey = Boolean(
    env.CLAUDE_CODE_API_KEY ||
      env.ANTHROPIC_API_KEY ||
      env.OPENAI_API_KEY ||
      env.GEMINI_API_KEY,
  )

  const scenario = scenarioForIntent(
    opts.explicitScenario,
    Boolean(opts.hasExplicitIntent),
  )
  const legacyOnlyPath =
    opts.bypassLegacyOnly ??
    (isLegacyAlias(opts.selectedModel) || Boolean(env.CLAUDE_CODE_MODEL))

  const receipt: MultifactorShadowReceipt = {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    scenario: scenario.scenario,
    scenarioOrigin: scenario.origin,
    profileVersion: PROFILE_VERSION,
    factors: factorSnapshot(env),
    ranking: {
      status: 'legacy',
      reason:
        legacyOnlyPath === true
          ? 'legacy single-route selection; no candidate ranking generated in slice 1'
          : 'no ranking engine wired in slice 1',
    },
    legacySelectedRoute: {
      provider: opts.provider,
      transport: opts.transport ?? 'direct',
      model: opts.selectedModel,
      hasApiKey,
    },
    bypassSignals: {
      envModelOverride: Boolean(env.CLAUDE_CODE_MODEL),
      envBaseUrlOverride: Boolean(
        env.CLAUDE_CODE_BASE_URL || env.ANTHROPIC_BASE_URL,
      ),
      envApiKeyOverride: Boolean(
        env.CLAUDE_CODE_API_KEY || env.ANTHROPIC_API_KEY,
      ),
      envModelMaxTokensOverride: Boolean(env.CLAUDE_CODE_MODEL_MAX_TOKENS),
      directUrlOverride: Boolean(opts.directUrl),
      legacyOnlyPath,
      any: false,
    },
  }

  const b = receipt.bypassSignals
  b.any =
    b.envModelOverride ||
    b.envBaseUrlOverride ||
    b.envApiKeyOverride ||
    b.envModelMaxTokensOverride ||
    b.directUrlOverride ||
    b.legacyOnlyPath

  return deepFreeze(receipt)
}

function deepFreeze<T extends Record<string, unknown>>(value: T): T {
  for (const key of Object.keys(value)) {
    const child = value[key]
    if (child && typeof child === 'object')
      deepFreeze(child as Record<string, unknown>)
  }
  return Object.freeze(value)
}

/** transport tag 的唯一解析入口；绝不在此之外按 pool 私选模型。 */
export function resolveTransportTag(
  provider: ReturnType<typeof getAPIProvider>,
): TransportTag {
  if (provider === 'firstParty') return 'direct'
  if (provider === 'openai' || provider === 'opencode-free') return 'direct'
  return 'legacy'
}
