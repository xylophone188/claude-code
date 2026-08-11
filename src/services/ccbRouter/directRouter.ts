import { findProvider, loadProviders } from '../providerRegistry/loader.js'
import type { ProviderConfig } from '../providerRegistry/types.js'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { chooseAccounts, isProviderFailure } from './accountPool.js'
import { resolveModel } from '../routing/index.js'
import {
  getAutoCandidateTiers,
  refreshAutoHealth,
  scorePoolSync,
} from '../routing/autoScoring.js'
import { refreshNvidiaModelsCache } from '../nvidiaModelDiscovery.js'
import { routeLog, routeError } from '../routing/stageLog.js'
import {
  isChatGPTAuthMode,
  isChatGPTCodexReasoningModel,
} from '../../utils/model/chatgptModels.js'

const LOCAL_CODEX_ADVISOR = '__ccb_local_codex_advisor__'
const LOCAL_CODEX_ADVISOR_ALIASES =
  /^(?:ccb\/)?(?:advisor|lite|full|ultra|review|smart|opus)$/i

export interface DirectRoute {
  providerId: string
  baseURL: string
  model: string
  apiKey: string
  headers?: Record<string, string>
  timeoutMs?: number
  compatRule?: ProviderConfig['compatRule']
  accountId?: string
  kind: 'opencode' | 'provider' | 'race'
  race?: boolean
  tier?: 'l1' | 'l2' | 'l3' | 'l4' | 'l5' | 'l6'
  raceDelayMs?: number
  headroomMode?: 'token' | 'cache'
}

const OPENCODE_URL = 'https://opencode.ai/zen/v1'
const OPENCODE_MODEL = 'deepseek-v4-flash-free'
/**
 * Fast timeout for opencode-free direct requests. The openai client defaults
 * to 600s; without this an unresponsive upstream hangs the whole turn for up
 * to 10 minutes per attempt. 15s is generous for a real completion and lets
 * the retry/failover path close quickly.
 */
const OPENCODE_TIMEOUT_MS = Number(process.env.OPENCODE_TIMEOUT_MS) || 15_000
const AUTO_ROUTE_TIMEOUT_MS =
  Number(process.env.CCB_AUTO_ROUTE_TIMEOUT_MS) || 30_000
const NVIDIA_AUTO_ROUTE_TIMEOUT_MS = 30_000
type CcbTierConfig = {
  tiers?: Record<string, string[]>
  providers?: Array<{ id?: string; autoModel?: string; defaultModel?: string }>
}

function ccbTierRoutes(): DirectRoute[] {
  const path =
    process.env.CCB_ROUTING_CONFIG ??
    join(homedir(), '.ccb-embed', 'providers.json')
  if (!existsSync(path)) return []
  try {
    const config = JSON.parse(readFileSync(path, 'utf8')) as CcbTierConfig
    const providers = new Map(
      (config.providers ?? [])
        .filter((provider): provider is typeof provider & { id: string } =>
          Boolean(provider.id),
        )
        .map(provider => [provider.id, provider]),
    )
    return ['L1', 'L2', 'L3', 'L4', 'L5', 'L6'].flatMap(level =>
      (config.tiers?.[level] ?? []).flatMap(providerId => {
        const provider = providers.get(providerId)
        const model = provider?.autoModel ?? provider?.defaultModel
        if (!model) return []
        const modelName = model.startsWith(`${providerId}/`)
          ? model.slice(providerId.length + 1)
          : model
        return resolveDirectRoutes(`${providerId}/${modelName}`)
      }),
    )
  } catch {
    return []
  }
}

function normalizeBaseURL(url: string): string {
  return url.replace(/\/(?:chat\/completions|responses|models)\/?$/, '')
}

function routeFor(
  provider: ProviderConfig,
  model: string,
): DirectRoute | undefined {
  const account = chooseAccounts(provider)[0]
  if (!account) return undefined
  return {
    providerId: provider.id,
    baseURL: normalizeBaseURL(provider.baseUrl),
    model: account.model || model || provider.defaultModel,
    apiKey: account.apiKey,
    ...(provider.headers ? { headers: provider.headers } : {}),
    compatRule: provider.compatRule,
    accountId: account.id,
    timeoutMs: provider.timeoutMs,
    kind: 'provider',
  }
}

function routesFor(provider: ProviderConfig, model: string): DirectRoute[] {
  const accounts = chooseAccounts(provider)
  return accounts.map(account => ({
    providerId: provider.id,
    baseURL: normalizeBaseURL(provider.baseUrl),
    model: account.model || model || provider.defaultModel,
    apiKey: account.apiKey,
    ...(provider.headers ? { headers: provider.headers } : {}),
    compatRule: provider.compatRule,
    accountId: account.id,
    timeoutMs: provider.timeoutMs,
    kind: 'provider' as const,
  }))
}

function opencode(model: string): DirectRoute {
  return {
    providerId: 'opencode',
    baseURL: process.env.OPENCODE_ZEN_BASE_URL ?? OPENCODE_URL,
    model: model || process.env.OPENCODE_FREE_MODEL || OPENCODE_MODEL,
    apiKey: 'public',
    headers: { 'x-opencode-client': 'desktop', Accept: 'text/event-stream' },
    timeoutMs: OPENCODE_TIMEOUT_MS,
    kind: 'opencode',
  }
}

function opencodeRaceModels(models: string[]): string[] {
  return models.slice(0, 2)
}

function configured(
  raw: string,
): { provider: ProviderConfig; model: string } | undefined {
  const parts = raw.split('/').filter(Boolean)
  for (let count = Math.min(3, parts.length); count > 0; count--) {
    const provider = findProvider(parts.slice(0, count).join('/'))
    if (provider) {
      return { provider, model: parts.slice(count).join('/') }
    }
  }
  return undefined
}

function configuredCcb(
  raw: string,
): { provider: ProviderConfig; model: string } | undefined {
  const parts = raw.split('/').filter(Boolean)
  for (let count = Math.min(3, parts.length); count > 0; count--) {
    const provider = findProvider(`ccb/${parts.slice(0, count).join('/')}`)
    if (provider) return { provider, model: parts.slice(count).join('/') }
  }
  return undefined
}

function withHeadroom(
  route: DirectRoute,
  tier: 'l1' | 'l2' | 'l3' | 'l4' | 'l5' | 'l6',
): DirectRoute {
  const headroomMode = tier === 'l1' ? 'token' : 'cache'
  const baseURL =
    headroomMode === 'token'
      ? process.env.CCB_HEADROOM_TOKEN_BASE_URL
      : process.env.CCB_HEADROOM_CACHE_BASE_URL
  if (!baseURL || !/^https?:\/\//i.test(baseURL))
    return { ...route, tier, headroomMode }
  return {
    ...route,
    tier,
    headroomMode,
    baseURL: normalizeBaseURL(baseURL),
    headers: {
      ...route.headers,
      'x-headroom-base-url': route.baseURL,
      // Headroom keeps the base URL path and forwards this value verbatim.
      // `/v1/chat/completions` here would become `/v1/v1/chat/completions`.
      'x-headroom-original-path': '/chat/completions',
    },
  }
}

function raceDelayMs(prompt: string | undefined, index: number): number {
  if (index < 2) return 0
  const text = prompt?.toLowerCase() ?? ''
  const speed = /(?:quick|fast|brief|简单|快速|尽快|一句|short)/.test(text)
  const quality =
    /(?:code|debug|refactor|architect|review|复杂|编程|调试|重构|架构|审查)/.test(
      text,
    )
  const base = speed ? 120 : quality ? 320 : 220
  return Math.min(900, base * index)
}

function raceRoutesFor(provider: ProviderConfig, model: string): DirectRoute[] {
  const routes = routesFor(provider, model)
  // NVIDIA keys are independent, but every other provider has a shared
  // upstream quota. CodeBuddy's remaining accounts are L1 downgrade paths.
  if (provider.id === 'nvidia' || provider.id === 'codebuddy-cn') return routes
  return routes.slice(0, 1)
}

function autoRoutes(prompt?: string): DirectRoute[] {
  // Warm the probe cache in the background; this call uses the last snapshot.
  void refreshAutoHealth()
  const tiers = getAutoCandidateTiers()
  const resolve = (
    candidates: string[],
    tier: 'l1' | 'l2' | 'l3' | 'l4' | 'l5' | 'l6',
    race = false,
  ): DirectRoute[] => {
    const routes: DirectRoute[] = []
    let candidateIndex = 0
    let nvidiaAccountIndex = 0
    const scored = scorePoolSync(candidates, prompt)
    const opencodeRaceCandidates = race
      ? new Set(
          opencodeRaceModels(
            scored
              .map(({ candidate }) => candidate)
              .filter(candidate => candidate.startsWith('opencode/')),
          ),
        )
      : undefined
    for (const { candidate } of scored) {
      const delayMs = race ? raceDelayMs(prompt, candidateIndex++) : 0
      if (candidate.startsWith('opencode/')) {
        if (isProviderFailure('opencode')) {
          routeLog('rank', 'skip cooled provider opencode')
          continue
        }
        const model = candidate.slice('opencode/'.length)
        if (!model) continue
        routes.push(
          withHeadroom(
            {
              ...opencode(model),
              ...(race && opencodeRaceCandidates?.has(candidate)
                ? { race: true, raceDelayMs: delayMs }
                : {}),
            },
            tier,
          ),
        )
        continue
      }
      const match = configured(candidate) ?? configuredCcb(candidate)
      if (!match) {
        routeLog('candidates', `unresolvable ${candidate}`)
        continue
      }
      if (isProviderFailure(match.provider.id)) {
        routeLog('rank', `skip cooled provider ${match.provider.id}`)
        continue
      }
      const allProviderRoutes = race
        ? raceRoutesFor(match.provider, match.model)
        : routesFor(match.provider, match.model)
      const providerRoutes =
        race && match.provider.id === 'nvidia'
          ? allProviderRoutes.length
            ? [
                allProviderRoutes[
                  nvidiaAccountIndex++ % allProviderRoutes.length
                ],
              ]
            : []
          : allProviderRoutes
      if (!providerRoutes.length) {
        routeLog('candidates', `no accounts ${candidate}`)
        continue
      }
      const resolvedRoutes = providerRoutes.map(route =>
        withHeadroom(
          {
            ...route,
            ...(race ? { race: true, raceDelayMs: delayMs } : {}),
            timeoutMs:
              route.providerId === 'nvidia'
                ? NVIDIA_AUTO_ROUTE_TIMEOUT_MS
                : Math.min(
                    route.timeoutMs ?? AUTO_ROUTE_TIMEOUT_MS,
                    AUTO_ROUTE_TIMEOUT_MS,
                  ),
          },
          tier,
        ),
      )
      if (race && match.provider.id === 'codebuddy-cn') {
        const [primary, ...fallbacks] = resolvedRoutes
        if (primary) routes.push(primary)
        routes.push(...fallbacks.map(route => ({ ...route, race: false })))
      } else routes.push(...resolvedRoutes)
    }
    return routes
  }
  const tierKeys = ['l1', 'l2', 'l3', 'l4', 'l5', 'l6'] as const
  const routesByTier: DirectRoute[][] = []
  const summary: string[] = []
  for (const key of tierKeys) {
    const built = resolve(tiers[key], key, key === 'l1')
    routesByTier.push(built)
    summary.push(`${key}=${built.length}`)
  }
  const routes = routesByTier.flat()
  routeLog(
    'rank',
    `auto routes (${summary.join(' ')})`,
    routes
      .map(
        r =>
          `${r.providerId}/${r.model}${r.accountId ? `#${r.accountId}` : ''}`,
      )
      .join(' -> '),
  )
  if (!routes.length) {
    routeError('auto: no routes resolved, all candidates failed')
  }
  return routes
}

export function resolveDirectRoute(spec: string): DirectRoute | undefined {
  // Codex subscription models use the native Responses path, never an
  // OpenAI-compatible provider endpoint.
  if (isChatGPTAuthMode() && isChatGPTCodexReasoningModel(spec))
    return undefined
  const namespaced = spec.trim().replace(/^ccb\//i, '')
  const raw = namespaced.replace(/^oc\//i, 'opencode/')
  if (!raw) return undefined
  if (/^opencode\//i.test(raw)) return opencode(raw.slice(raw.indexOf('/') + 1))
  if (/^auto(?:\/|$)/i.test(raw)) return autoRoutes()[0]
  const match = configured(raw) ?? configuredCcb(raw)
  return match ? routeFor(match.provider, match.model) : undefined
}

function comboRoutes(spec: string, prompt?: string): DirectRoute[] | undefined {
  const inner = spec.replace(/^ccb\//i, '')
  const resolved =
    inner === 'advisor' ? resolveModel('advisor-combo') : resolveModel(inner)
  if (!resolved) return undefined
  if ('provider' in resolved) {
    const route = resolveDirectRoute(
      `ccb/${resolved.provider.id}/${resolved.model}`,
    )
    return route ? [route] : []
  }
  return resolved.combo.models.flatMap(model => {
    const route = resolveDirectRoute(`ccb/${model}`)
    return route ? [route] : []
  })
}

export function resolveDirectRoutes(
  spec: string,
  prompt?: string,
): DirectRoute[] {
  // See resolveDirectRoute: codex models bypass embed + registry.
  if (isChatGPTAuthMode() && isChatGPTCodexReasoningModel(spec)) return []
  if (/^(?:ccb\/)?race(?:\/|$)/i.test(spec.trim())) {
    const routes = autoRoutes(prompt)
    if (routes.length) return routes
  }
  // `advisor` starts with local Codex; the OpenAI adapter appends auto routes
  // so a depleted account pool cannot halt the session.
  if (isChatGPTAuthMode() && LOCAL_CODEX_ADVISOR_ALIASES.test(spec.trim())) {
    return [
      {
        providerId: LOCAL_CODEX_ADVISOR,
        baseURL: '',
        model: LOCAL_CODEX_ADVISOR,
        apiKey: '',
        kind: 'provider',
      },
      ...autoRoutes(prompt),
    ]
  }
  const raw = spec.trim()
  if (/^(?:ccb\/)?ccb$/i.test(raw)) return ccbTierRoutes()
  if (/^(?:auto|ccb\/auto)(?:\/|$)/i.test(raw)) return autoRoutes(prompt)
  if (
    /^(?:ccb\/)?(?:advisor|advisor-combo|lite|full|ultra|review|smart|opus|code|rr|panel)$/i.test(
      raw,
    )
  ) {
    const combo = comboRoutes(raw, prompt)
    if (combo) return combo
  }
  const namespaced = raw
    .trim()
    .replace(/^ccb\//i, '')
    .replace(/^oc\//i, 'opencode/')
  if (/^opencode\//i.test(namespaced))
    return [resolveDirectRoute(raw)].filter(Boolean) as DirectRoute[]
  const match = configured(namespaced) ?? configuredCcb(namespaced)
  return match ? routesFor(match.provider, match.model) : []
}

export function listDirectProviderModels(): Array<{
  providerId: string
  models: string[]
}> {
  return loadProviders().map(provider => ({
    providerId: provider.id.replace(/^ccb\//i, ''),
    models: provider.models?.length ? provider.models : [provider.defaultModel],
  }))
}
