import { execFile } from 'node:child_process'

import type { ModelOption } from './modelOptions.js'

export interface ProviderModelGroup {
  /** Stable provider key used as the /model level-1 select value. */
  id: string
  label: string
  models: ModelOption[]
}

const DEFAULT_BASE_URL = 'http://127.0.0.1:8787'
export const APISIX_BASE_URL =
  process.env.APISIX_BASE_URL ?? 'http://127.0.0.1:20128'
const APISIX_PREFIX = 'apisix/'
const CACHE_TTL_MS = 24 * 60 * 60 * 1000

/** Gateway first-path-segment → friendly provider name. */
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
  apisix: 'APISIX',
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
const PROVIDER_ORDER = ['oc', 'openai', 'apisix', 'anthropic', 'gemini', 'grok']
const OPENAI_PROVIDER = 'openai'

function ocModelToOption(id: string): ModelOption {
  const name = id.slice('oc/'.length)
  return {
    value: `opencode/${name}`,
    label: `OpenCode Free · ${name}`,
    description: 'OpenCode Free via local Headroom gateway',
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
 * True for model ids the Headroom gateway serves directly (any provider
 * prefix the gateway exposes). Used to route those ids through the local
 * OpenAI-compatible gateway client instead of the ChatGPT/Codex backend.
 */
export function isGatewayModel(model: string | null | undefined): boolean {
  if (!model) return false
  const m = model.toLowerCase()
  // opencode/* ids already route via the opencode-free client.
  if (m.startsWith('opencode/')) return false
  // openai/* ids stay on the curated ChatGPT/Codex path.
  if (m.startsWith('openai/')) return false
  // Anything with a known/unknown gateway prefix is served by the gateway.
  if (m.includes('/')) return true
  return m.includes('gemini') || m.includes('grok')
}

/**
 * True for `apisix/*` ids served by the local 9router/omniroute gateway
 * (default http://127.0.0.1:20128). These route to APISIX_BASE_URL instead of
 * the Headroom gateway, and the `apisix/` prefix is stripped before sending.
 */
export function isApisixModel(model: string | null | undefined): boolean {
  return !!model?.toLowerCase().startsWith(APISIX_PREFIX)
}

/** Group gateway model ids into provider buckets. Exported for tests. */
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

/** Fetch a JSON body via the curl CLI. Headroom (Bun) writes chunked responses
 *  with DECIMAL chunk sizes (`1190352\r\n`) which node's undici parser reads as
 *  hex and hangs on; curl tolerates them. Kept local to the headroom fetch —
 *  APISIX (9router) responses parse fine under undici. */
function fetchViaCurl(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    execFile(
      'curl',
      ['-s', '--max-time', '25', url],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return reject(err)
        try {
          resolve(JSON.parse(stdout))
        } catch (parseErr) {
          reject(parseErr)
        }
      },
    )
  })
}

/** Model ids served by the headroom gateway. Never throws: an unreachable or
 *  slow gateway yields an empty list so the caller still shows the APISIX and
 *  OpenAI groups. */
async function fetchGatewayModelIds(): Promise<string[]> {
  try {
    const base = (
      process.env.OPENCODE_FREE_BASE_URL ?? DEFAULT_BASE_URL
    ).replace(/\/v1$/, '')
    const json = (await fetchViaCurl(`${base}/v1/models`)) as {
      data?: Array<{ id?: unknown }>
    }
    return (json.data ?? [])
      .map(m => m.id)
      .filter((x): x is string => typeof x === 'string' && x.length > 0)
  } catch {
    return []
  }
}

/** Model ids from the local 9router/omniroute gateway, prefixed `apisix/`.
 *  Never throws: an unreachable/misconfigured gateway yields an empty list so
 *  the picker still works with the Headroom groups. */
async function fetchApisixModelIds(): Promise<string[]> {
  try {
    const base = APISIX_BASE_URL.replace(/\/v1$/, '').replace(/\/+$/, '')
    const res = await fetch(`${base}/api/v1/models`, {
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) return []
    const json = (await res.json()) as { data?: Array<{ id?: unknown }> }
    return (json.data ?? [])
      .map(m => m.id)
      .filter((x): x is string => typeof x === 'string' && x.length > 0)
      .map(id => `${APISIX_PREFIX}${id}`)
  } catch {
    return []
  }
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

/** Gateway-derived provider groups with a 24h in-memory cache. Never throws:
 *  each source fails independently — an unreachable headroom gateway still
 *  shows the APISIX/OpenAI groups (plus the hardcoded OpenCode fallback so the
 *  default model stays selectable), and vice versa. Only when BOTH sources are
 *  empty does the picker fall back to the single OpenCode free model. */
export async function getProviderModelGroups(): Promise<ProviderModelGroup[]> {
  const now = Date.now()
  if (cache && now - cache.ts < CACHE_TTL_MS) return cache.groups
  const [gatewayIds, apisixIds] = await Promise.all([
    fetchGatewayModelIds(),
    fetchApisixModelIds(),
  ])
  let groups: ProviderModelGroup[]
  if (gatewayIds.length === 0 && apisixIds.length === 0) {
    groups = fallbackGroups()
  } else {
    const ids = [...gatewayIds, ...apisixIds]
    // Keep the default OpenCode free model selectable when headroom is down.
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

/** Curated ChatGPT/Codex options keep effort + subscription routing. */
export async function getProviderModelOptions(
  providerId: string,
): Promise<ModelOption[]> {
  if (providerId === OPENAI_PROVIDER) {
    const { getChatGPTCodexModelOptions } = await import('./modelOptions.js')
    return getChatGPTCodexModelOptions()
  }
  const groups = await getProviderModelGroups()
  return groups.find(g => g.id === providerId)?.models ?? []
}
