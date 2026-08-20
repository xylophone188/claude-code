import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { ModelOption } from './modelOptions.js'
import {
  getLocalGatewayName,
  getRegisteredProviders,
} from './providerRegistry.js'
import { listDirectProviderModels } from '../../services/omniroute/adapter.js'
import { getAutoCandidates } from '../../services/routing/autoScoring.js'

/** Home directory, read at call time: `os.homedir()` caches its value at
 *  startup in Bun, so tests overriding process.env.HOME would be ignored
 *  without this fallback. */
const homeDir = (): string => process.env.HOME ?? homedir()

export interface ProviderModelGroup {
  /** Stable provider key used as the /model level-1 select value. */
  id: string
  label: string
  models: ModelOption[]
}

const CCB_PREFIX = 'ccb/'
const CCB_ROUTING_PREFIX = 'ccb/'
const CACHE_TTL_MS = 24 * 60 * 60 * 1000

/** Stable level-1 provider ids for the two-step /model picker. */
export const PROVIDER_OC = 'oc'
export const PROVIDER_OPENAI = 'openai'
export const PROVIDER_CCB = 'ccb'
export const PROVIDER_ADD = 'add-provider'
export const PROVIDER_DELETE = 'delete-provider'
export const PROVIDER_DEFAULT = 'default'
export const PROVIDER_SWITCH = 'switch'
export const PROVIDER_AUTO = 'auto'
export const PROVIDER_ADVISOR = 'advisor'
export const PROVIDER_MANAGED = 'managed'
export const PROVIDER_MANAGE = 'manage'

/** Level-2 content behind a level-1 provider entry. */
export interface ProviderContent {
  kind:
    | 'models'
    | 'combos'
    | 'subproviders'
    | 'info'
    | 'managed'
    | 'manage'
    | 'delete'
  options: ModelOption[]
  /** Read-only lines rendered by the 'info' kind. */
  lines?: string[]
}

/** Provider first-path-segment to friendly provider name. */
const PREFIX_NAMES: Record<string, string> = {
  oc: 'OpenCode',
  openrouter: 'OpenRouter',
  'github-models': 'GitHub Models',
  github: 'GitHub',
  gh: 'GitHub',
  ghm: 'GitHub Models',
  gitee: 'Gitee',
  'codebuddy-cn': 'CodeBuddy',
  cbcn: 'CodeBuddy',
  cerebras: 'Cerebras',
  groq: 'Groq',
  mistral: 'Mistral',
  nvidia: 'NVIDIA',
  cohere: 'Cohere',
  kimi: 'Kimi',
  cf: 'Cloudflare',
  'cloudflare-ai': 'Cloudflare AI',
  af: 'API Airforce',
  'api-airforce': 'API Airforce',
  kr: 'Kiro',
  kiro: 'Kiro',
  voyage: 'Voyage AI',
  'voyage-ai': 'Voyage AI',
  'jina-ai': 'Jina AI',
  deepgram: 'Deepgram',
  'amazon-q': 'Amazon Q',
  auto: 'Auto',
  agentrouter: 'AgentRouter',
  codex: 'Codex',
  bzl: 'BazzaLink',
  bazaarlink: 'BazzaLink',
  comfyui: 'ComfyUI',
  cx: 'CX',
  felo: 'Felo',
  ge: 'GE',
  inworld: 'Inworld',
  lc: 'LC',
  llm7: 'LLM7',
  longcat: 'Longcat',
  md: 'MD',
  aq: 'AQ',
  ccb: 'CCB',
}

/** Family-keyword groups, checked before prefix grouping (user asked for
 *  anthropic / gemini / grok style providers). */
const FAMILY_GROUPS: {
  id: string
  label: string
  match: (m: string) => boolean
}[] = [
  {
    id: 'anthropic',
    label: 'Anthropic',
    match: m => m.includes('claude') || m.includes('anthropic'),
  },
  { id: 'gemini', label: 'Gemini', match: m => m.includes('gemini') },
  { id: 'grok', label: 'Grok', match: m => m.includes('grok') },
]

/** Provider ordering for the level-1 menu: OpenCode (default) first. */
const PROVIDER_ORDER = ['oc', 'openai', 'ccb', 'anthropic', 'gemini', 'grok']

function ocModelToOption(id: string): ModelOption {
  const name = id.slice('oc/'.length)
  return {
    value: `opencode/${name}`,
    label: `OpenCode Free · ${name}`,
    description: 'OpenCode Free via Zen',
  }
}

function gatewayModelToOption(id: string): ModelOption {
  const name = id.split('/').slice(1).join('/') || id
  return {
    value: id,
    label: name,
    description: `via ${id}`,
  }
}

/**
 * True for provider-prefixed model ids handled by CCB's direct transport.
 */
export function isGatewayModel(model: string | null | undefined): boolean {
  if (!model) return false
  const m = model.toLowerCase()
  // opencode/* ids already route via the opencode-free client.
  if (m.startsWith('opencode/')) return false
  // openai/* ids stay on the curated ChatGPT/Codex path.
  if (m.startsWith('openai/')) return false
  // ccb/* ids (in-repo ccb upstream providers) resolve via
  // OPENAI_BASE_URL and must use direct CCB transport.
  if (m.startsWith(CCB_ROUTING_PREFIX)) return true
  // Any provider-prefixed id uses CCB transport.
  if (m.includes('/')) return true
  return m.includes('gemini') || m.includes('grok')
}

/**
 * True for `ccb/*` ids served by CCB's direct provider transport.
 */
export function isCCBModel(model: string | null | undefined): boolean {
  return !!model?.toLowerCase().startsWith(CCB_PREFIX)
}

/**
 * True for `ccb/*` ids (in-repo ccb upstream providers). These resolve
 * through CCB's direct provider transport.
 */
export function isCCBRoutingModel(model: string | null | undefined): boolean {
  return !!model?.toLowerCase().startsWith(CCB_ROUTING_PREFIX)
}

/** Group provider model ids into provider buckets. Exported for tests. */
export function buildGroups(ids: string[]): ProviderModelGroup[] {
  const groups = new Map<string, ProviderModelGroup>()
  const more: string[] = []

  const push = (id: string, label: string, modelId: string): void => {
    let g = groups.get(id)
    if (!g) {
      g = { id, label, models: [] }
      groups.set(id, g)
    }
    g.models.push(
      modelId.startsWith('oc/')
        ? ocModelToOption(modelId)
        : gatewayModelToOption(modelId),
    )
  }

  for (const id of ids) {
    const lower = id.toLowerCase()
    // OpenCode group: free oc/ models only (paid oc models fall through to
    // their family group or "More").
    if (id.startsWith('oc/') && lower.includes('free')) {
      push('oc', 'OpenCode', id)
      continue
    }
    const family = FAMILY_GROUPS.find(f => f.match(lower))
    if (family) {
      push(family.id, family.label, id)
      continue
    }
    if (id.startsWith('openai/')) continue // covered by the curated ChatGPT path
    if (lower.startsWith('anthropic-compatible')) {
      push('anthropic', 'Anthropic', id)
      continue
    }
    if (lower.startsWith('openai-compatible-chat')) {
      push('openai', 'OpenAI', id)
      continue
    }
    const first = id.split('/')[0]
    // Paid oc/* models (no "free") never join the free-only OpenCode group.
    if (first === 'oc') {
      more.push(id)
      continue
    }
    const name = PREFIX_NAMES[first]
    if (name) {
      push(first, name, id)
      continue
    }
    more.push(id)
  }

  // Sort OpenCode models: deepseek-v4-flash-free first, then alphabetically.
  const oc = groups.get('oc')
  if (oc) {
    oc.models.sort((a, b) => {
      const aFree = (a.value ?? '').includes('deepseek-v4-flash-free') ? 0 : 1
      const bFree = (b.value ?? '').includes('deepseek-v4-flash-free') ? 0 : 1
      if (aFree !== bFree) return aFree - bFree
      return a.label.localeCompare(b.label)
    })
  }

  const result = [...groups.values()].sort((a, b) => {
    const ia = PROVIDER_ORDER.indexOf(a.id)
    const ib = PROVIDER_ORDER.indexOf(b.id)
    const ra = ia === -1 ? PROVIDER_ORDER.length : ia
    const rb = ib === -1 ? PROVIDER_ORDER.length : ib
    if (ra !== rb) return ra - rb
    return a.label.localeCompare(b.label)
  })

  if (more.length > 0) {
    result.push({
      id: 'more',
      label: 'More',
      models: more.map(gatewayModelToOption),
    })
  }
  return result
}

function embeddedModelIds(): string[] {
  return listDirectProviderModels().flatMap(({ providerId, models }) =>
    models.map(model => `${CCB_PREFIX}${providerId}/${model}`),
  )
}

function embeddedProviderIds(): string[] {
  return listDirectProviderModels().map(({ providerId }) => providerId)
}

function embeddedModelsFor(providerId: string): string[] {
  return listDirectProviderModels()
    .filter(({ providerId: id }) => id === providerId)
    .flatMap(({ models }) => models)
}

/** True when the Codex CLI is logged in (`~/.codex/auth.json` exists with a
 *  non-empty `tokens` object). Pure file check — no auth module import, which
 *  would risk a circular dependency. */
export function isCodexLoggedIn(): boolean {
  try {
    const authPath = join(homeDir(), '.codex', 'auth.json')
    if (!existsSync(authPath)) return false
    const auth = JSON.parse(readFileSync(authPath, 'utf8')) as {
      tokens?: unknown
    }
    return (
      typeof auth.tokens === 'object' &&
      auth.tokens !== null &&
      Object.keys(auth.tokens as object).length > 0
    )
  } catch {
    return false
  }
}

/** Model ids whose first path segment matches `providerId`, deduplicated.
 *  Segment-boundary match so `kimi` does not capture `kimiko/...`. */
export function filterModelsByProvider(
  modelIds: string[],
  providerId: string,
): string[] {
  const seen = new Set<string>()
  return modelIds.filter(id => {
    if (id.split('/')[0] !== providerId) return false
    if (seen.has(id)) return false
    seen.add(id)
    return true
  })
}

/** Group non-combo model ids into sub-provider options (value = first path
 *  segment, friendly label from PREFIX_NAMES when known). */
export function buildSubproviders(modelIds: string[]): ModelOption[] {
  const counts = new Map<string, number>()
  for (const id of modelIds) {
    const seg = id.split('/')[0]
    counts.set(seg, (counts.get(seg) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([seg, count]) => ({
      value: seg,
      label: PREFIX_NAMES[seg] ?? seg,
      description: `${count} model${count === 1 ? '' : 's'}`,
    }))
}

/** Catalog of addable providers for the "添加供应商" flow. */
export function buildProviderCatalog(modelIds: string[]): ModelOption[] {
  const counts = new Map<string, number>()
  for (const id of modelIds) {
    const seg = id.split('/')[0]
    if (seg === PROVIDER_CCB) continue
    counts.set(seg, (counts.get(seg) ?? 0) + 1)
  }
  const result: ModelOption[] = [
    {
      value: PROVIDER_CCB,
      label: getLocalGatewayName(),
      description: 'CCB 内置供应商',
    },
  ]
  for (const [seg, count] of [...counts.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    result.push({
      value: seg,
      label: PREFIX_NAMES[seg] ?? seg,
      description: `${count} model${count === 1 ? '' : 's'}`,
    })
  }
  return result
}

/** Addable providers derived from CCB's embedded catalog. */
export async function getProviderCatalog(): Promise<ModelOption[]> {
  const ids = embeddedModelIds()
  return buildProviderCatalog(ids)
}

/** Level-2 content for a level-1 provider entry of the two-step /model
 *  picker. See ProviderContent for the three shapes. */
export async function getProviderContent(
  providerId: string,
): Promise<ProviderContent> {
  if (providerId === PROVIDER_ADVISOR) {
    return {
      kind: 'info',
      options: [],
      lines: [
        '顾问路由：顶级模型只做方案、复核、最终验收。',
        '自动路由：子代理执行改动、测试、脏累杂活。',
        '复杂任务会启动后台 Workflow；/ccb -p <任务> 可直接启动。',
      ],
    }
  }
  if (providerId === PROVIDER_DEFAULT) {
    const codexLoggedIn = isCodexLoggedIn()
    if (codexLoggedIn) {
      const { getChatGPTCodexModelOptions } = await import('./modelOptions.js')
      return { kind: 'models', options: getChatGPTCodexModelOptions() }
    }
    return {
      kind: 'subproviders',
      options: listDirectProviderModels().map(({ providerId: id }) => ({
        value: id,
        label: PREFIX_NAMES[id] ?? id,
        description: 'CCB 直连供应商',
      })),
    }
  }
  if (providerId === PROVIDER_SWITCH) {
    const providers = getRegisteredProviders()
    return {
      kind: 'subproviders',
      options: [
        ...listDirectProviderModels().map(({ providerId: id }) => ({
          value: id,
          label: PREFIX_NAMES[id] ?? id,
          description: 'CCB 直连供应商',
        })),
        ...providers
          .filter(p => p.providerId !== PROVIDER_CCB)
          .map(p => ({
            value: p.providerId,
            label: p.name,
            description: '已添加',
          })),
      ],
    }
  }
  if (providerId === PROVIDER_DELETE) {
    const providers = getRegisteredProviders().filter(
      p => p.providerId !== PROVIDER_CCB,
    )
    return {
      kind: 'delete',
      options: providers.map(p => ({
        value: p.id,
        label: p.name,
        description: '删除该供应商',
      })),
      lines: ['选择供应商后回车删除，Esc 返回。'],
    }
  }
  if (providerId === PROVIDER_AUTO) {
    return {
      kind: 'info',
      options: [],
      lines: buildAutoInfoLines(),
    }
  }
  if (providerId === PROVIDER_MANAGED) {
    // "已接入供应商"：展示所有已注册 provider，含开关状态和模型禁用状态
    return {
      kind: 'managed',
      options: await buildManagedOptions(),
    }
  }
  if (providerId === PROVIDER_MANAGE) {
    // "管理供应商"：展示所有已注册 provider，支持删除/重命名/禁用
    return {
      kind: 'manage',
      options: await buildManageOptions(),
      lines: buildManageInfoLines(),
    }
  }
  if (providerId === PROVIDER_OC || providerId === PROVIDER_OPENAI) {
    return {
      kind: 'models',
      options: await getProviderModelOptions(providerId),
    }
  }
  if (providerId === PROVIDER_CCB) {
    return {
      kind: 'subproviders',
      options: listDirectProviderModels().map(({ providerId: id }) => ({
        value: id,
        label: PREFIX_NAMES[id] ?? id,
        description: 'CCB 直连供应商',
      })),
    }
  }
  const matched = embeddedModelsFor(providerId)
  return {
    kind: 'models',
    options: matched.map(model => ({
      value: `${CCB_PREFIX}${providerId}/${model}`,
      label: model,
      description: `CCB 直连 ${providerId}`,
    })),
  }
}

/** Read-only explainer for the auto-routing entry: the actual candidate
 *  pool and the scoring policy. Not a picker — routing picks automatically. */
function buildAutoInfoLines(): string[] {
  const candidates = getAutoCandidates()
  const pool = candidates
    .map(candidate => {
      const slash = candidate.indexOf('/')
      const provider = slash > 0 ? candidate.slice(0, slash) : ''
      const model = slash > 0 ? candidate.slice(slash + 1) : candidate
      return `  ${PREFIX_NAMES[provider] ?? provider} · ${model}`
    })
    .join('\n')
  return [
    `自动路由候选池（${candidates.length} 个）：`,
    pool,
    '评分：探针直连上游 /models 测健康与延迟，加权成本、稳定性等因子；',
    '探针缓存 30 秒，无数据时取中性分，故障自动降级。',
  ]
}

function fallbackGroups(): ProviderModelGroup[] {
  return [
    {
      id: 'oc',
      label: 'OpenCode',
      models: [
        ocModelToOption(
          `oc/${process.env.OPENCODE_FREE_MODEL ?? 'deepseek-v4-flash-free'}`,
        ),
      ],
    },
  ]
}

let cache: { ts: number; groups: ProviderModelGroup[] } | null = null

/** Test-only: clear the 24h in-memory group cache. */
export function resetProviderModelGroupsCache(): void {
  cache = null
}

/** Direct-provider groups with a 24h in-memory cache. */
export async function getProviderModelGroups(): Promise<ProviderModelGroup[]> {
  const now = Date.now()
  if (cache && now - cache.ts < CACHE_TTL_MS) return cache.groups
  const gatewayIds: string[] = []
  const ccbIds = embeddedModelIds()
  let groups: ProviderModelGroup[]
  if (gatewayIds.length === 0 && ccbIds.length === 0) {
    groups = fallbackGroups()
  } else {
    const ids = [...gatewayIds, ...ccbIds]
    // Keep the default OpenCode free model selectable.
    if (gatewayIds.length === 0) {
      ids.push(
        `oc/${process.env.OPENCODE_FREE_MODEL ?? 'deepseek-v4-flash-free'}`,
      )
    }
    groups = buildGroups(ids)
  }
  cache = { ts: now, groups }
  return groups
}

/** "已接入供应商" option rows: each registered provider (skip disabled) plus
 *  their model disable toggles, prefixed with a status marker. Disabled
 *  providers are hidden from this list but shown in "管理供应商". */
async function buildManagedOptions(): Promise<ModelOption[]> {
  const providers = getRegisteredProviders().filter(p => !p.disabled)
  const options: ModelOption[] = []
  for (const p of providers) {
    if (p.providerId === PROVIDER_CCB) {
      options.push({
        value: PROVIDER_CCB,
        label: `● ${p.name}`,
        description: 'CCB 内置网关',
      })
      continue
    }
    const disabled = (p.disabledModels ?? []).length
    options.push({
      value: p.providerId,
      label: `● ${p.name}`,
      description: disabled > 0 ? `${disabled} 个模型已禁用` : '已接入',
    })
  }
  return options
}

/** "管理供应商" option rows: every registered provider (incl. disabled) with
 *  its state and management affordances. */
async function buildManageOptions(): Promise<ModelOption[]> {
  return getRegisteredProviders().map(p => {
    const state = p.disabled ? '已停用' : '已启用'
    const disabled = (p.disabledModels ?? []).length
    return {
      value: p.id,
      label: `${p.disabled ? '○' : '●'} ${p.name}`,
      description: `${state}${disabled > 0 ? ` · ${disabled} 个模型禁用` : ''}`,
    }
  })
}

/** Read-only hint for the "管理供应商" panel. */
function buildManageInfoLines(): string[] {
  return [
    '选择供应商后进入操作菜单：回车切换启用/禁用，d 删除，r 重命名。',
    'Esc 返回供应商列表。',
  ]
}

/** Curated ChatGPT/Codex options keep effort + subscription routing. Always
 *  equals `(await getProviderContent(providerId)).options` — in the
 *  combos/subproviders cases those options are directly selectable model ids,
 *  so the compat layer just forwards. */
export async function getProviderModelOptions(
  providerId: string,
): Promise<ModelOption[]> {
  if (providerId === PROVIDER_OPENAI) {
    const { getChatGPTCodexModelOptions } = await import('./modelOptions.js')
    return getChatGPTCodexModelOptions()
  }
  if (providerId === PROVIDER_OC) {
    const groups = await getProviderModelGroups()
    return groups.find(g => g.id === PROVIDER_OC)?.models ?? []
  }
  const content = await getProviderContent(providerId)
  return content.options
}

/** Level-1 /model menu: auto-routing first, then OpenCode free, OpenAI
 * (Codex login only), CCB providers, registered custom providers, and
 * finally "添加供应商". */
export async function getProviderList(): Promise<ModelOption[]> {
  const codexLoggedIn = isCodexLoggedIn()
  const embedded = embeddedProviderIds().length
  const registered = getRegisteredProviders().filter(
    p => p.providerId !== PROVIDER_CCB,
  )
  const totalManaged = embedded + registered.length

  return [
    {
      value: PROVIDER_DEFAULT,
      label: '默认模式',
      description: codexLoggedIn
        ? 'OpenAI + 已添加供应商'
        : `CCB 直连 ${embedded} 个供应商`,
    },
    {
      value: PROVIDER_SWITCH,
      label: '切换供应商',
      description: `已接入 ${totalManaged} 个供应商`,
    },
    {
      value: PROVIDER_ADD,
      label: '添加供应商',
      description: '注册新的模型供应商',
    },
    {
      value: PROVIDER_DELETE,
      label: '删除供应商',
      description: '移除已添加的供应商',
    },
  ]
}
