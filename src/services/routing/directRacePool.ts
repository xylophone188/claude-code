import type { DirectRoute } from '../omniroute/adapter.js'
import { loadProviders } from '../providerRegistry/loader.js'
import {
  currentFreeOpenCodeModels,
  DEFAULT_AUTO_CANDIDATES,
  filterOpenCodeCandidates,
  getAutoCandidateTiers,
} from './autoScoring.js'

/** OpenCode Zen base URL, mirroring autoScoring's refresh endpoint. */
const OPENCODE_ZEN_BASE_URL =
  process.env.OPENCODE_ZEN_BASE_URL ?? 'https://opencode.ai/zen/v1'

export interface RaceSpec {
  provider: 'opencode' | 'nvidia'
  model: string
}

const RACE_CAPS = {
  opencode: 4,
  nvidia: 4,
} as const

/** Allowed NVIDIA models for direct tool-call races. */
const ALLOWED_NVIDIA_MODELS = new Set([
  'nemotron-3.5-lightning-30b-a3b',
  'nvidia/nemotron-3.5-lightning-30b-a3b',
  'nemotron-3-super-120b-a12b',
  'nvidia/nemotron-3-super-120b-a12b',
  'nemotron-3-ultra-550b-a55b',
  'nvidia/nemotron-3-ultra-550b-a55b',
  'moonshotai/kimi-k3',
])

/** Free models are read through autoScoring's validated 8-hour cache owner. */
export const readFreshOpenCodeModels = currentFreeOpenCodeModels

function isOpencodeSpec(spec: string): boolean {
  const provider = spec.slice(0, spec.indexOf('/')).toLowerCase()
  return provider === 'opencode' || provider === 'oc'
}

function addSpec(
  specs: RaceSpec[],
  seen: Set<string>,
  counts: Record<RaceSpec['provider'], number>,
  provider: RaceSpec['provider'],
  model: string,
): void {
  const trimmed = model.trim()
  if (!trimmed || counts[provider] >= RACE_CAPS[provider]) return
  const key = `${provider}/${trimmed}`
  if (seen.has(key)) return
  seen.add(key)
  counts[provider]++
  specs.push({ provider, model: trimmed })
}

/** Strip up to one leading "nvidia/" provider prefix and canonicalize. */
function canonicalNvidiaModel(model: string): string {
  const trimmed = model.trim()
  return trimmed.toLowerCase().startsWith('nvidia/')
    ? trimmed
    : 'nvidia/' + trimmed
}

/** Bounded L1 selection: up to 4 OpenCode free models and up to 4 NVIDIA
 *  candidates from the allowlist. Non-generation providers (gitee etc.)
 *  are never eligible. */
export function selectRaceSpecs(
  l1: string[],
  freshOpenCodeModels: string[],
  nvidiaFallbackModel?: string,
  nvidiaExtraCandidates: string[] = [],
): RaceSpec[] {
  const specs: RaceSpec[] = []
  const seen = new Set<string>()
  const counts: Record<RaceSpec['provider'], number> = {
    opencode: 0,
    nvidia: 0,
  }
  // Retired models are never eligible to race, whatever the candidate source.
  const eligibleL1 = filterOpenCodeCandidates(l1)
  for (const candidate of eligibleL1) {
    if (isOpencodeSpec(candidate)) {
      addSpec(
        specs,
        seen,
        counts,
        'opencode',
        candidate.slice(candidate.indexOf('/') + 1),
      )
    }
  }
  for (const model of filterOpenCodeCandidates(freshOpenCodeModels))
    addSpec(specs, seen, counts, 'opencode', model)
  const nvidiaCandidates = [...eligibleL1, ...nvidiaExtraCandidates].filter(
    candidate => candidate.toLowerCase().startsWith('nvidia/'),
  )
  let nvidiaMatched = false
  for (const candidate of nvidiaCandidates) {
    const stripped = canonicalNvidiaModel(candidate)
    if (!ALLOWED_NVIDIA_MODELS.has(stripped)) continue
    nvidiaMatched = true
    addSpec(specs, seen, counts, 'nvidia', stripped)
  }
  if (!nvidiaMatched && nvidiaFallbackModel) {
    const stripped = canonicalNvidiaModel(nvidiaFallbackModel)
    if (ALLOWED_NVIDIA_MODELS.has(stripped)) {
      addSpec(specs, seen, counts, 'nvidia', stripped)
    }
  }
  return specs
}

export interface RacePoolOverrides {
  /** L1 candidate specs; defaults to getAutoCandidateTiers().l1. */
  candidates?: string[]
  /** Pre-read fresh OpenCode models (tests); skips the cache file. */
  freshOpenCodeModels?: string[]
  /** NVIDIA keys (tests); skips providers.json. */
  nvidiaKeys?: string[]
  /** NVIDIA model used when no l1 spec names nvidia. */
  nvidiaFallbackModel?: string
  /** Extra NVIDIA agent candidates merged into the race; defaults to the
   *  built-in DEFAULT_AUTO_CANDIDATES so the full agent model set races. */
  nvidiaDefaultCandidates?: string[]
}

/** Build the L1 direct race pool in front of the resolved fallback routes.
 *  OpenCode free models and NVIDIA accounts race concurrently; every base
 *  route drops one tier to L2 fallback. Returns baseRoutes unchanged when
 *  no race candidate exists, so callers keep their current behavior. */
export function buildDirectRacePool(
  baseRoutes: DirectRoute[],
  overrides: RacePoolOverrides = {},
): DirectRoute[] {
  if (baseRoutes.length === 0) return baseRoutes
  const l1 = overrides.candidates ?? getAutoCandidateTiers().l1
  const fresh = overrides.freshOpenCodeModels ?? readFreshOpenCodeModels()
  const providers = loadProviders()
  const nvidia = providers.find(provider => provider.id === 'nvidia')
  const nvidiaKeys =
    overrides.nvidiaKeys ??
    (nvidia?.accounts ?? [])
      .map(account => account.apiKey)
      .filter((key): key is string => Boolean(key))
  const nvidiaFallbackModel =
    overrides.nvidiaFallbackModel ?? nvidia?.defaultModel
  const nvidiaDefaultCandidates =
    overrides.nvidiaDefaultCandidates ?? DEFAULT_AUTO_CANDIDATES
  const opencode = providers.find(provider => provider.id === 'opencode')
  const specs = selectRaceSpecs(
    l1,
    fresh,
    nvidiaFallbackModel,
    nvidiaDefaultCandidates,
  )
  const raceRoutes: DirectRoute[] = []
  let nvidiaKeyIndex = 0
  for (const spec of specs) {
    if (spec.provider === 'opencode') {
      raceRoutes.push({
        providerId: 'opencode',
        baseURL: OPENCODE_ZEN_BASE_URL,
        model: spec.model,
        apiKey: opencode?.accounts?.[0]?.apiKey ?? 'public',
        headers: {
          'x-opencode-client': 'desktop',
          Accept: 'text/event-stream',
          ...(opencode?.headers ?? {}),
        },
        kind: 'opencode',
        race: true,
        tier: 'l1',
      })
      continue
    }
    if (nvidiaKeys.length === 0) continue
    const key = nvidiaKeys[nvidiaKeyIndex % nvidiaKeys.length]
    if (!key) continue
    nvidiaKeyIndex++
    raceRoutes.push({
      providerId: 'nvidia',
      baseURL: nvidia?.baseUrl ?? 'https://integrate.api.nvidia.com/v1',
      model: spec.model,
      apiKey: key,
      headers: nvidia?.headers,
      timeoutMs: nvidia?.timeoutMs,
      kind: 'provider',
      race: true,
      tier: 'l1',
    })
  }
  if (raceRoutes.length === 0) return baseRoutes
  return [
    ...raceRoutes,
    ...baseRoutes.map(route => ({ ...route, tier: route.tier ?? 'l2' })),
  ]
}
