/**
 * OmniRoute adapter — replaces the legacy ccbRouter runtime path.
 *
 * Direct-route resolution and account management go through the OmniRoute
 * OpenAI-compatible gateway. Configuration priority is CCB_HEADROOM_BASE_URL,
 * OMNIRUTE_URL, OMNIROUTE_BASE_URL, OPENAI_BASE_URL, then the canonical APISIX
 * ingress on port 20128. APISIX owns the CCB-to-OmniRoute hop.
 */

import { existsSync, readFileSync, statSync } from 'fs'
import { basename, dirname, join, resolve } from 'path'
import {
  getOriginalCwd,
  getProjectRoot,
  getSessionId,
} from '../../bootstrap/state.js'
import { getGoal } from '../goal/goalState.js'
import { findProvider, loadProviders } from '../providerRegistry/loader.js'
import type { ProviderConfig } from '../providerRegistry/types.js'
import { parseGitRemote } from '../../utils/detectRepository.js'

export interface DirectRoute {
  providerId: string
  baseURL: string
  model: string
  apiKey: string
  routeId?: 'omniroute/ccb-chat' | 'omniroute/9router' | '9router/direct'
  receiptPolicy?: 'omniroute' | 'omniroute-9router' | 'none'
  headers?: Record<string, string>
  timeoutMs?: number
  compatRule?: ProviderConfig['compatRule']
  accountId?: string
  kind: 'opencode' | 'provider' | 'race' | 'custom'
  race?: boolean
  tier?: 'l1' | 'l2' | 'l3' | 'l4' | 'l5' | 'l6'
  raceDelayMs?: number
  headroomMode?: 'token' | 'cache'
}

/**
 * Identity CCB can safely provide to OmniRoute. Project and context-provider
 * choice deliberately do not belong here: OmniRoute owns both decisions.
 */
export type OmniRouteIntent =
  | 'auto'
  | 'chat'
  | 'coding'
  | 'plan'
  | 'review'
  | 'advisor'

export type OmniRouteCostTier = 'economy' | 'balanced' | 'quality'

export interface OmniRouteRequestMetadata {
  workspace?: string
  gitRemote?: string
  gitRevision?: string
  repo?: string
  mission?: string
  sessionId?: string
  requestId?: string
  intent?: OmniRouteIntent
  deadlineMs?: number
  costTier?: OmniRouteCostTier
}

const gitRemoteCache = new Map<string, string | null>()
const HEADER_CONTROL_CHARS = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`,
  'g',
)

function headerValue(
  value: string | undefined,
  maxLength = 1024,
): string | undefined {
  if (!value) return undefined
  const sanitized = value
    .normalize('NFC')
    .replace(HEADER_CONTROL_CHARS, ' ')
    .trim()
    .slice(0, maxLength)
  return sanitized || undefined
}

function redactGitRemote(remote: string | undefined): string | undefined {
  const value = headerValue(remote)
  if (!value) return undefined
  try {
    const url = new URL(value)
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return headerValue(url.toString().replace(/\/$/, ''))
  } catch {
    // SCP-style Git URLs have no URL parser support. They contain no password
    // field, so keep their repository identity after normal header sanitizing.
    return value
  }
}

function remoteUrlFromConfig(configPath: string): string | undefined {
  try {
    const lines = readFileSync(configPath, 'utf8').split(/\r?\n/)
    let currentRemote: string | undefined
    let firstRemoteUrl: string | undefined
    for (const line of lines) {
      const section = line.match(/^\s*\[remote\s+"([^"]+)"\]\s*$/i)
      if (section) {
        currentRemote = section[1]
        continue
      }
      if (/^\s*\[/.test(line)) {
        currentRemote = undefined
        continue
      }
      const url = line.match(/^\s*url\s*=\s*(.+?)\s*$/i)?.[1]
      if (!currentRemote || !url) continue
      if (currentRemote === 'origin') return url
      firstRemoteUrl ??= url
    }
    return firstRemoteUrl
  } catch {
    return undefined
  }
}

function gitDirectoryForWorkspace(workspace: string): string | undefined {
  const dotGit = join(workspace, '.git')
  try {
    const stat = statSync(dotGit)
    if (stat.isDirectory()) return dotGit
    if (!stat.isFile()) return undefined
    const gitFile = readFileSync(dotGit, 'utf8').trim()
    const gitDir = gitFile.match(/^gitdir:\s*(.+)$/im)?.[1]
    return gitDir ? resolve(dirname(dotGit), gitDir.trim()) : undefined
  } catch {
    return undefined
  }
}

function gitCommonDirectory(gitDirectory: string): string | undefined {
  try {
    const commonDir = join(gitDirectory, 'commondir')
    if (existsSync(commonDir)) {
      const relativeCommonDir = readFileSync(commonDir, 'utf8').trim()
      if (relativeCommonDir) {
        return resolve(gitDirectory, relativeCommonDir)
      }
    }
  } catch {
    // A regular repository has no commondir file.
  }
  return undefined
}

function gitConfigPaths(workspace: string): string[] {
  const gitDirectory = gitDirectoryForWorkspace(workspace)
  if (!gitDirectory) return []
  const commonDirectory = gitCommonDirectory(gitDirectory)
  return [gitDirectory, commonDirectory]
    .filter((value): value is string => Boolean(value))
    .map(directory => join(directory, 'config'))
}

function normalizeGitRevision(value: string | undefined): string | undefined {
  const revision = headerValue(value, 64)?.toLowerCase()
  return revision && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(revision)
    ? revision
    : undefined
}

function isSafeGitRef(ref: string): boolean {
  return (
    /^refs\/[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref) &&
    !ref.includes('..') &&
    !ref.includes('//') &&
    !ref.endsWith('/')
  )
}

function readGitRef(gitDirectory: string, ref: string): string | undefined {
  try {
    return normalizeGitRevision(
      readFileSync(join(gitDirectory, ref), 'utf8').trim(),
    )
  } catch {
    return undefined
  }
}

function readPackedGitRef(
  gitDirectory: string,
  ref: string,
): string | undefined {
  try {
    for (const line of readFileSync(
      join(gitDirectory, 'packed-refs'),
      'utf8',
    ).split(/\r?\n/)) {
      const match = line.match(/^([0-9a-fA-F]{40}|[0-9a-fA-F]{64})\s+(.+)$/)
      if (match?.[2] === ref) return normalizeGitRevision(match[1])
    }
  } catch {
    // Loose refs cover usual active branches; packed refs are optional.
  }
  return undefined
}

function getGitRevisionForWorkspace(workspace: string): string | undefined {
  const gitDirectory = gitDirectoryForWorkspace(workspace)
  if (!gitDirectory) return undefined
  try {
    const head = readFileSync(join(gitDirectory, 'HEAD'), 'utf8').trim()
    const detachedRevision = normalizeGitRevision(head)
    if (detachedRevision) return detachedRevision
    const ref = head.match(/^ref:\s*(.+)$/)?.[1]?.trim()
    if (!ref || !isSafeGitRef(ref)) return undefined
    const directories = [gitDirectory, gitCommonDirectory(gitDirectory)].filter(
      (value): value is string => Boolean(value),
    )
    for (const directory of directories) {
      const looseRevision = readGitRef(directory, ref)
      if (looseRevision) return looseRevision
      const packedRevision = readPackedGitRef(directory, ref)
      if (packedRevision) return packedRevision
    }
  } catch {
    return undefined
  }
  return undefined
}

function getGitRemoteForWorkspace(workspace: string): string | undefined {
  const cached = gitRemoteCache.get(workspace)
  if (cached !== undefined) return cached ?? undefined
  const remote = gitConfigPaths(workspace)
    .map(remoteUrlFromConfig)
    .find((value): value is string => Boolean(value))
  gitRemoteCache.set(workspace, remote ?? null)
  return remote
}

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/
const MIN_DEADLINE_MS = 1_000
const MAX_DEADLINE_MS = 600_000
const OMNIROUTE_INTENTS = new Set<OmniRouteIntent>([
  'auto',
  'chat',
  'coding',
  'plan',
  'review',
  'advisor',
])
const OMNIROUTE_COST_TIERS = new Set<OmniRouteCostTier>([
  'economy',
  'balanced',
  'quality',
])

function normalizeRequestId(value: string | undefined): string | undefined {
  const requestId = value?.trim()
  return requestId && REQUEST_ID_PATTERN.test(requestId) ? requestId : undefined
}

function normalizeDeadlineMs(value: unknown): number | undefined {
  const deadlineMs = typeof value === 'number' ? value : Number(value)
  return Number.isInteger(deadlineMs) &&
    deadlineMs >= MIN_DEADLINE_MS &&
    deadlineMs <= MAX_DEADLINE_MS
    ? deadlineMs
    : undefined
}

function normalizeCostTier(
  value: string | undefined,
): OmniRouteCostTier | undefined {
  const costTier = value?.trim().toLowerCase() as OmniRouteCostTier | undefined
  return costTier && OMNIROUTE_COST_TIERS.has(costTier) ? costTier : undefined
}

function normalizeIntent(
  value: string | undefined,
): OmniRouteIntent | undefined {
  const intent = value?.trim().toLowerCase() as OmniRouteIntent | undefined
  return intent && OMNIROUTE_INTENTS.has(intent) ? intent : undefined
}

function getIntentForModel(spec: string): OmniRouteIntent | undefined {
  const stripped = spec.trim().replace(/^ccb\//i, '')
  if (/^advisor$/i.test(stripped)) return 'advisor'
  if (/^(?:ccb-plan|plan|ultra|smart|opus)$/i.test(stripped)) return 'plan'
  if (/^(?:ccb-review|review)$/i.test(stripped)) return 'review'
  if (/^(?:ccb-coding|work)$/i.test(stripped)) return 'coding'
  if (/^ccb-main$/i.test(stripped)) return 'auto'
  if (/^(?:ccb-chat|auto|race|chat)(?:\/|$)/i.test(stripped)) return 'chat'
  return undefined
}

/** Collect request-scoped identity without resolving a Context project. */
export function getOmniRouteRequestMetadata(): OmniRouteRequestMetadata {
  let workspace: string | undefined
  let sessionId: string | undefined
  let mission: string | undefined
  try {
    workspace = headerValue(getProjectRoot() || getOriginalCwd())
    sessionId = headerValue(getSessionId())
    mission = headerValue(
      getGoal()?.objective ?? process.env.OMNIROUTE_MISSION,
      512,
    )
  } catch {
    workspace = headerValue(process.cwd())
  }
  const gitRemote = workspace
    ? redactGitRemote(getGitRemoteForWorkspace(workspace))
    : undefined
  const gitRevision = workspace
    ? getGitRevisionForWorkspace(workspace)
    : undefined
  const parsedRemote = gitRemote ? parseGitRemote(gitRemote) : null
  return {
    workspace,
    gitRemote,
    gitRevision,
    repo: headerValue(
      parsedRemote?.name ?? (workspace ? basename(workspace) : undefined),
    ),
    mission,
    sessionId,
    deadlineMs: normalizeDeadlineMs(process.env.CCB_REQUEST_DEADLINE_MS),
    costTier: normalizeCostTier(process.env.CCB_COST_TIER),
  }
}

function encodeMissionHeader(value: string | undefined): string | undefined {
  const mission = headerValue(value, 2048)
  return mission ? `uri:${encodeURIComponent(mission)}` : undefined
}

function encodeHeaderValue(value: string | undefined): string | undefined {
  const sanitized = headerValue(value)
  return sanitized ? `uri:${encodeURIComponent(sanitized)}` : undefined
}

/**
 * Headers for the CCB-to-OmniRoute hop. They describe local request identity
 * only; no `project`, context source, model, or MCP provider is sent by CCB.
 */
export function buildOmniRouteRequestHeaders(
  metadata: OmniRouteRequestMetadata = getOmniRouteRequestMetadata(),
): Record<string, string> {
  // Client identity is descriptive only. OmniRoute owns pool, model, Context,
  // and provider selection.
  const headers: Record<string, string> = { 'X-OmniRoute-Client': 'ccb' }
  const values: Array<[string, string | undefined]> = [
    ['X-OmniRoute-Workspace', encodeHeaderValue(metadata.workspace)],
    ['X-OmniRoute-Git-Remote', redactGitRemote(metadata.gitRemote)],
    ['X-OmniRoute-Git-Revision', normalizeGitRevision(metadata.gitRevision)],
    ['X-OmniRoute-Repo', headerValue(metadata.repo)],
    ['X-OmniRoute-Mission', encodeMissionHeader(metadata.mission)],
    ['X-OmniRoute-Session-Id', headerValue(metadata.sessionId)],
    ['X-OmniRoute-Request-Id', normalizeRequestId(metadata.requestId)],
    ['X-OmniRoute-Intent', normalizeIntent(metadata.intent)],
    [
      'X-OmniRoute-Deadline-Ms',
      normalizeDeadlineMs(metadata.deadlineMs)?.toString(),
    ],
    ['X-OmniRoute-Cost-Tier', normalizeCostTier(metadata.costTier)],
  ]
  for (const [name, value] of values) {
    if (value) headers[name] = value
  }
  return headers
}

// ── Configuration ──────────────────────────────────────────────────

/**
 * Label CCB sends to OmniRoute for its main (bare/profile) entry. Configurable
 * via CCB_ROUTE_NAME; defaults to ccb-main so no route label is hardcoded.
 */
const HERMES_SCORE_ROUTE = 'hermes-score'

function isHermesScoreRoute(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === HERMES_SCORE_ROUTE
}

export function getCcbRouteName(): string {
  const configuredRoute = process.env.CCB_ROUTE_NAME?.trim()
  return configuredRoute && !isHermesScoreRoute(configuredRoute)
    ? configuredRoute
    : 'ccb-main'
}

export interface OmniRouteConfig {
  baseUrl: string
  apiKey: string
  /** If true, OmniRoute handles race/auto routing server-side. */
  serverSideRouting: boolean
}

export interface LocalFallbackConfig {
  baseUrl: string
  apiKey: string
  model: string
}

let cachedConfig: OmniRouteConfig | null | undefined
let cachedFallbackConfig: LocalFallbackConfig | null | undefined

export function getLocalFallbackConfig(): LocalFallbackConfig | null {
  if (cachedFallbackConfig !== undefined) return cachedFallbackConfig
  const baseUrl = process.env.CCB_FALLBACK_BASE_URL?.trim()
  const apiKey = process.env.CCB_FALLBACK_API_KEY?.trim()
  if (!baseUrl || !apiKey) {
    cachedFallbackConfig = null
    return cachedFallbackConfig
  }
  const fallbackModel = process.env.CCB_FALLBACK_MODEL?.trim()
  cachedFallbackConfig = {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    apiKey,
    model:
      fallbackModel && !isHermesScoreRoute(fallbackModel)
        ? fallbackModel
        : 'ccb-main',
  }
  return cachedFallbackConfig
}

export function getOmniRouteConfig(): OmniRouteConfig | null {
  if (cachedConfig !== undefined) return cachedConfig
  const baseUrl =
    process.env.CCB_HEADROOM_BASE_URL ??
    process.env.OMNIRUTE_URL ??
    process.env.OMNIROUTE_BASE_URL ??
    process.env.OPENAI_BASE_URL ??
    'http://127.0.0.1:20128/v1'
  const apiKey =
    process.env.OMNIRUTE_API_KEY ??
    process.env.OMNIROUTE_API_KEY ??
    // OpenAI's SDK rejects an empty key before issuing the request. The local
    // APISIX ingress is the authenticated boundary; this placeholder only
    // enables its compatible transport when no caller credential is required.
    'omniroute-local'
  cachedConfig = {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    apiKey,
    serverSideRouting: process.env.OMNIROUTE_SERVER_ROUTING !== '0',
  }
  return cachedConfig
}

/** Reset cached config (for tests). */
export function resetOmniRouteConfig(): void {
  cachedConfig = undefined
  cachedFallbackConfig = undefined
}

// ── Route Resolution ───────────────────────────────────────────────

/**
 * Resolve direct routes for a model spec. When OmniRoute is configured,
 * delegates routing to the OmniRoute gateway.
 */
export function resolveDirectRoutes(
  spec: string,
  prompt?: string,
): DirectRoute[] {
  const config = getOmniRouteConfig()
  if (!config) return []
  const raw = spec.trim()
  if (!raw) return []
  // Preserve native ChatGPT/Codex and Anthropic paths for bare model names and
  // virtual advisor aliases. OmniRoute owns explicit CCB/auto/race/provider
  // routes only; otherwise it would silently bypass OAuth Responses routing.
  const isGatewayRoute =
    /^(?:ccb(?:-|\/)|auto(?:\/|$)|race(?:\/|$)|chat(?:\/|$)|advisor$|plan$|review$|work$|ultra$|smart$|opus$)/i.test(
      raw,
    ) ||
    /^(?:ccb\/|ccb-main$)/i.test(raw) ||
    (raw.includes('/') &&
      !/^(?:advisor|lite|full|ultra|review|smart|opus)$/i.test(raw))
  if (!isGatewayRoute) return []
  return resolveViaOmniRoute(spec, prompt, config)
}

function resolveOmniRoute9RouterRoute(config: OmniRouteConfig): DirectRoute {
  const model = process.env.OMNIROUTE_9ROUTER_MODEL?.trim()
  if (!model || !/^9router\/[^/]+\/.+/.test(model)) {
    throw new Error(
      'Route omniroute/9router requires OMNIROUTE_9ROUTER_MODEL matching 9router/<provider>/<model>.',
    )
  }
  return {
    providerId: 'omniroute-9router',
    baseURL: config.baseUrl,
    model,
    apiKey: config.apiKey,
    routeId: 'omniroute/9router',
    receiptPolicy: 'omniroute-9router',
    headers: buildOmniRouteRequestHeaders(),
    kind: 'provider',
  }
}

function resolveDirect9RouterRoute(config: OmniRouteConfig): DirectRoute {
  const baseURL = process.env.NINEROUTER_BASE_URL?.trim()
  const model = process.env.NINEROUTER_MODEL?.trim()
  const apiKey = process.env.NINEROUTER_API_KEY?.trim() || '9router-local'
  if (!baseURL) {
    throw new Error('Route 9router/direct requires NINEROUTER_BASE_URL.')
  }
  if (!model) {
    throw new Error('Route 9router/direct requires NINEROUTER_MODEL.')
  }
  if (!apiKey) {
    throw new Error('Route 9router/direct requires NINEROUTER_API_KEY.')
  }
  if (hasSameIngress(baseURL, config.baseUrl)) {
    throw new Error(
      'Route 9router/direct requires NINEROUTER_BASE_URL to differ from the OmniRoute ingress.',
    )
  }
  return {
    providerId: '9router',
    baseURL: baseURL.replace(/\/+$/, ''),
    model,
    apiKey,
    routeId: '9router/direct',
    receiptPolicy: 'none',
    kind: 'provider',
  }
}

function hasSameIngress(left: string, right: string): boolean {
  try {
    const leftUrl = new URL(left)
    const rightUrl = new URL(right)
    return (
      leftUrl.origin === rightUrl.origin &&
      leftUrl.pathname.replace(/\/+$/, '') ===
        rightUrl.pathname.replace(/\/+$/, '')
    )
  } catch {
    return left.replace(/\/+$/, '') === right.replace(/\/+$/, '')
  }
}

// ── Explicit Provider Route Resolution ─────────────────────────────
//
// `opencode/<model>` and `provider/model` specs bypass the broad OmniRoute
// slash passthrough and resolve to a direct upstream route. Credentials come
// from the local provider registry only — nothing here is ever sent to the
// OmniRoute gateway.

/** Hard-excluded provider id. */
const BLOCKED_PROVIDER_ID = 'gitee'

/** Non-secret placeholder for `noAuth` providers so they stay routable. */
const NO_AUTH_PLACEHOLDER = 'ccb-public'

const DEFAULT_OPENCODE_ZEN_BASE_URL = 'https://opencode.ai/zen/v1'

function isBlockedProvider(providerId: string): boolean {
  return providerId.toLowerCase() === BLOCKED_PROVIDER_ID
}

/** Resolve a provider-level credential: apiKey, then apiKeyEnv env value. */
function resolveProviderKey(provider: ProviderConfig): string {
  const direct = provider.apiKey?.trim()
  if (direct) return direct
  const fromEnv = provider.apiKeyEnv
    ? (process.env[provider.apiKeyEnv]?.trim() ?? '')
    : ''
  return fromEnv
}

/** Resolve an account-level credential, falling back to the provider key. */
function resolveAccountKey(
  account: NonNullable<ProviderConfig['accounts']>[number],
  providerKey: string,
): string {
  const direct = account.apiKey?.trim()
  if (direct) return direct
  const fromEnv = account.apiKeyEnv
    ? (process.env[account.apiKeyEnv]?.trim() ?? '')
    : ''
  return fromEnv || providerKey
}

/**
 * Choose accounts for a provider: every enabled account with a usable
 * credential. Account-level `model` overrides are preserved. When a provider
 * has no accounts array, a single provider-level account is returned if the
 * provider itself is usable. `gitee` is hard-excluded; `noAuth` providers get
 * a non-secret placeholder credential.
 */
export function chooseAccounts(
  provider: ProviderConfig,
): Array<{ id: string; apiKey: string; model?: string }> {
  if (isBlockedProvider(provider.id)) return []
  const providerKey = resolveProviderKey(provider)
  const usableProviderKey =
    providerKey || (provider.noAuth ? NO_AUTH_PLACEHOLDER : '')
  if (provider.accounts === undefined) {
    if (!usableProviderKey) return []
    return [
      {
        id: 'provider-default',
        apiKey: usableProviderKey,
        model: provider.defaultModel,
      },
    ]
  }
  const accounts: Array<{ id: string; apiKey: string; model?: string }> = []
  for (const account of provider.accounts) {
    if (account.enabled === false) continue
    if (account.quotaRemaining === 0) continue
    const apiKey = resolveAccountKey(account, usableProviderKey)
    if (!apiKey) continue
    accounts.push({
      id: account.id,
      apiKey,
      ...(account.model ? { model: account.model } : {}),
    })
  }
  return accounts
}

function resolveOpenCodeRoute(model: string): DirectRoute {
  return {
    providerId: 'opencode',
    baseURL: (
      process.env.OPENCODE_ZEN_BASE_URL ?? DEFAULT_OPENCODE_ZEN_BASE_URL
    ).replace(/\/+$/, ''),
    model,
    apiKey: 'public',
    headers: {
      'x-opencode-client': 'desktop',
      Accept: 'text/event-stream',
    },
    receiptPolicy: 'none',
    kind: 'opencode',
  }
}

function resolveExplicitProviderRoutes(stripped: string): DirectRoute[] | null {
  // `opencode/<model>` bypasses OmniRoute entirely and talks to Zen directly.
  const openCode = /^opencode\/(.+)$/i.exec(stripped)
  if (openCode?.[1]?.trim()) {
    return [resolveOpenCodeRoute(openCode[1].trim())]
  }
  // Longest known provider id wins, so namespaced ids like `nvidia/z-ai/glm-5.2`
  // match `nvidia` — not a shorter prefix like `n`.
  const providers = loadProviders()
  const providerId = providers
    .map(p => p.id)
    .filter(id => stripped.toLowerCase().startsWith(`${id.toLowerCase()}/`))
    .sort((a, b) => b.length - a.length)[0]
  if (!providerId) return null
  if (isBlockedProvider(providerId)) return []
  const model = stripped.slice(providerId.length + 1).trim()
  if (!model) return null
  const provider = findProvider(providerId, providers)
  if (!provider) return null
  return chooseAccounts(provider).map(account => ({
    providerId,
    baseURL: provider.baseUrl.replace(/\/+$/, ''),
    model: account.model ?? model,
    apiKey: account.apiKey,
    accountId: account.id,
    headers: provider.headers,
    timeoutMs: provider.timeoutMs,
    compatRule: provider.compatRule,
    receiptPolicy: 'none' as const,
    kind: 'provider' as const,
  }))
}

function resolveViaOmniRoute(
  spec: string,
  _prompt: string | undefined,
  config: OmniRouteConfig,
): DirectRoute[] {
  // OmniRoute acts as an OpenAI-compatible gateway: it accepts any
  // provider/model spec and routes to the appropriate upstream.
  const trimmed = spec.trim()
  if (!trimmed) return []

  // CCB has one routing policy. Do not let legacy auto/race aliases enter paid
  // auto combos; explicit provider/model specs remain passthrough diagnostics.
  //
  // `ccb/<provider>/<model>` is gateway-exclusive: CCB sends it to the APISIX
  // ingress and OmniRoute owns account fallback. Stripping the prefix first and
  // letting explicit-provider resolution match would hand the request straight
  // to the upstream, bypassing the ingress this file is named for. Bare
  // `provider/model` (no `ccb/` prefix) still resolves directly.
  const isCcbPrefixed = /^ccb\//i.test(trimmed)
  const stripped = trimmed.replace(/^ccb\//i, '')
  if (/^omniroute\/9router$/i.test(trimmed)) {
    return [resolveOmniRoute9RouterRoute(config)]
  }
  if (/^9router\/direct$/i.test(trimmed)) {
    return [resolveDirect9RouterRoute(config)]
  }
  if (!isCcbPrefixed) {
    const explicitRoutes = resolveExplicitProviderRoutes(stripped)
    if (explicitRoutes) return explicitRoutes
  }
  // Strip the ccb/ prefix, then normalize the route label. hermes-score must
  // never reach OmniRoute even via a ccb/ prefix.
  if (isHermesScoreRoute(stripped)) return []
  const modelSpec = /^ccb-main$/i.test(stripped)
    ? 'ccb-main'
    : /^(?:auto|race)$/i.test(stripped)
      ? getCcbRouteName()
      : /^(?:advisor|plan|ultra|smart|opus)$/i.test(stripped)
        ? 'ccb-plan'
        : /^review$/i.test(stripped)
          ? 'ccb-review'
          : /^work$/i.test(stripped)
            ? 'ccb-coding'
            : /^(?:auto|race|chat)(?:\/|$)/i.test(stripped)
              ? 'ccb-chat'
              : stripped

  const route: DirectRoute = {
    providerId: 'omniroute',
    baseURL: config.baseUrl,
    model: modelSpec,
    apiKey: config.apiKey,
    routeId: 'omniroute/ccb-chat',
    receiptPolicy: 'omniroute',
    headers: buildOmniRouteRequestHeaders({
      ...getOmniRouteRequestMetadata(),
      requestId: crypto.randomUUID(),
      intent: getIntentForModel(trimmed),
    }),
    kind: 'provider',
  }

  if (
    /^(?:auto\/|race\/|auto\/smart$|ccb-(?:chat|research|coding|plan|review|vision|crawl|search|score))/.test(
      modelSpec,
    )
  ) {
    return [route]
  }

  return [route]
}

// ── Provider Model Listing ─────────────────────────────────────────

/**
 * List configured generation providers and their models (excluding gitee),
 * plus the omniroute gateway's `auto` entry. No credentials are exposed.
 */
export function listDirectProviderModels(): Array<{
  providerId: string
  models: string[]
}> {
  const config = getOmniRouteConfig()
  if (!config) return []
  const providers = loadProviders()
    .filter(p => !isBlockedProvider(p.id))
    .map(p => ({
      providerId: p.id,
      models: p.models ?? (p.defaultModel ? [p.defaultModel] : []),
    }))
    .filter(entry => entry.models.length > 0)
  return [...providers, { providerId: 'omniroute', models: ['auto'] }]
}

// ── Account Pool ───────────────────────────────────────────────────

/**
 * Wait for a provider request slot. OmniRoute handles rate limiting
 * server-side, so this is a no-op.
 */
export async function waitForProviderRequestSlot(
  _providerId: string,
  _accountId?: string,
): Promise<void> {
  // OmniRoute gateway manages rate limiting server-side.
}

// ── Failure Tracking ───────────────────────────────────────────────

/** Mark an account as failed. No-op when OmniRoute manages accounts. */
export function markAccountFailure(
  _providerId: string,
  _accountId: string,
  _cooldownMs?: number,
): void {}

/** Clear an account failure. No-op when OmniRoute manages accounts. */
export function clearAccountFailure(
  _providerId: string,
  _accountId: string,
): void {}

/** Mark a provider as failed. No-op when OmniRoute manages routing. */
export function markProviderFailure(
  _providerId: string,
  _cooldownMs?: number,
): void {}

/** Check if a provider is in failure cooldown. Always false with OmniRoute. */
export function isProviderFailure(_providerId: string): boolean {
  return false
}

/** Mark a model as failed. No-op when OmniRoute manages routing. */
export function markModelFailure(
  _providerId: string,
  _model: string,
  _cooldownMs?: number,
): void {}

/** Clear a model failure. No-op when OmniRoute manages routing. */
export function clearModelFailure(_providerId: string, _model: string): void {}

/** Check if a model is in failure cooldown. Always false with OmniRoute. */
export function isModelFailure(_providerId: string, _model: string): boolean {
  return false
}

/** Update account quota from response headers. */
export function updateAccountQuota(
  _providerId: string,
  _accountId: string,
  _remaining: number,
): void {}

// ── Race Metrics ───────────────────────────────────────────────────

export type RaceErrorCategory =
  | 'rate_limit'
  | 'transient'
  | 'permanent'
  | 'auth'
  | 'timeout'
  | 'unknown'

function isCreditExhausted401(
  status: number | undefined,
  message: string,
): boolean {
  return (
    status === 401 &&
    /credits?\s+exhausted|quota\s+exhausted|all\s+\d+\s+connection/i.test(
      message,
    )
  )
}

export function classifyErrorStatus(
  status: number | undefined,
  aborted = false,
  errorMessage = '',
): RaceErrorCategory {
  if (aborted) return 'transient'
  if (status === undefined) return 'unknown'
  if (isCreditExhausted401(status, errorMessage)) {
    return 'rate_limit'
  }
  if (status === 429) return 'rate_limit'
  if (status === 401 || status === 403) return 'auth'
  if (status === 503 || status === 502 || status === 504) return 'transient'
  if (status === 404 || status === 400) return 'permanent'
  return 'unknown'
}

export type CcbRouteId = NonNullable<DirectRoute['routeId']>

export type CcbRouteProof = 'pending' | 'verified' | 'unverified' | 'direct'

export interface ActiveCcbRoute {
  provider: string
  model: string
  selectedRouteId?: CcbRouteId
  requestedRouteId?: CcbRouteId
  requestedModel?: string
  proof?: CcbRouteProof
}

export interface OmniRouteReceipt {
  requestId?: string
  provider?: string
  model?: string
  latencyMs?: number
  fallbackAttempts?: number
  compression?: string
  decision?: string
  cognitiveTask?: string
  cognitivePool?: string
  cognitiveContext?: string
  cognitiveEffort?: string
  cache?: string
  cacheHit?: boolean
  contextProject?: string
  contextProjectSource?: string
  contextSources?: string
  contextCache?: string
  contextBundle?: string
  contextTokens?: number
  contextFingerprint?: string
  contextCacheHit?: boolean
  routingReason?: string
  cacheDebug?: OmniRouteCacheDebug
}

/** Header-safe cache observability emitted by OmniRoute. */
export interface OmniRouteCacheDebug {
  client?: string
  routePool?: string
  sessionId?: string
  conversationFingerprint?: string
  contextHash?: string
  cacheKey?: string
  missReason?: string | null
}

let lastOmniRouteReceipt: OmniRouteReceipt | null = null
let lastOmniRouteError: string | null = null

export function recordOmniRouteError(error: unknown): void {
  const text = error instanceof Error ? error.message : String(error)
  lastOmniRouteError = text
    .replace(/Bearer\s+\S+/gi, 'Bearer <redacted>')
    .slice(0, 180)
}

export function getLastOmniRouteError(): string | null {
  return lastOmniRouteError
}

export function parseOmniRouteReceipt(
  headers: Headers,
): OmniRouteReceipt | null {
  const value = (name: string, maxLength = 1024) =>
    headerValue(headers.get(name) ?? undefined, maxLength)
  const number = (name: string) => {
    const n = Number(value(name))
    return Number.isFinite(n) ? n : undefined
  }
  const boolean = (name: string) => {
    const raw = value(name)?.toLowerCase()
    return raw === 'true' ? true : raw === 'false' ? false : undefined
  }
  const cacheDebug = parseOmniRouteCacheDebug(
    value('x-omniroute-cache-debug', 16_384),
  )
  const receipt: OmniRouteReceipt = {
    requestId: value('x-omniroute-request-id'),
    provider: value('x-omniroute-provider'),
    model: value('x-omniroute-model'),
    latencyMs: number('x-omniroute-latency-ms'),
    fallbackAttempts: number('x-omniroute-fallback-attempts'),
    compression: value('x-omniroute-compression'),
    decision: value('x-omniroute-decision'),
    cognitiveTask: value('x-omniroute-cognitive-task'),
    cognitivePool: value('x-omniroute-cognitive-pool'),
    cognitiveContext: value('x-omniroute-cognitive-context'),
    cognitiveEffort: value('x-omniroute-cognitive-effort'),
    cache: value('x-omniroute-cache'),
    cacheHit: boolean('x-omniroute-cache-hit'),
    contextProject: value('x-omniroute-context-project'),
    contextProjectSource: value('x-omniroute-context-project-source'),
    contextSources: value('x-omniroute-context-sources'),
    contextCache: value('x-omniroute-context-cache'),
    contextBundle: value('x-omniroute-context-bundle', 16_384),
    contextTokens: number('x-omniroute-context-tokens'),
    contextFingerprint: value('x-omniroute-context-fingerprint'),
    contextCacheHit: boolean('x-omniroute-context-cache-hit'),
    routingReason: value('x-omniroute-routing-reason'),
    cacheDebug,
  }
  if (!Object.values(receipt).some(v => v !== undefined)) return null
  lastOmniRouteReceipt = receipt
  if (receipt.provider && receipt.model) {
    setActiveCcbRoute(receipt.provider, receipt.model)
  }
  return receipt
}

function parseOmniRouteCacheDebug(
  raw: string | undefined,
): OmniRouteCacheDebug | undefined {
  if (!raw) return undefined
  try {
    const value = JSON.parse(raw)
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return undefined
    }
    const result: OmniRouteCacheDebug = {}
    for (const field of [
      'client',
      'routePool',
      'sessionId',
      'conversationFingerprint',
      'contextHash',
      'cacheKey',
    ] as const) {
      const entry = value[field]
      if (typeof entry === 'string') result[field] = headerValue(entry, 128)
    }
    if (typeof value.missReason === 'string') {
      result.missReason = headerValue(value.missReason, 256)
    } else if (value.missReason === null) {
      result.missReason = null
    }
    return Object.keys(result).length ? result : undefined
  } catch {
    return undefined
  }
}

export function getLastOmniRouteReceipt(): OmniRouteReceipt | null {
  return lastOmniRouteReceipt
}

let activeCcbRoute: ActiveCcbRoute | null = null

export function setActiveCcbRoute(provider: string, model: string): void {
  activeCcbRoute = { provider, model }
}

export function getActiveCcbRoute(): ActiveCcbRoute | null {
  return activeCcbRoute
}

export function beginCcbRoute(
  routeId: CcbRouteId,
  model: string,
  receiptPolicy: DirectRoute['receiptPolicy'],
): void {
  const proof: CcbRouteProof = receiptPolicy === 'none' ? 'direct' : 'pending'
  activeCcbRoute = {
    provider: '',
    model: '',
    selectedRouteId: routeId,
    requestedRouteId: routeId,
    requestedModel: model,
    proof,
  }
  // Clear any stale receipt/error for new request
  lastOmniRouteReceipt = null
  lastOmniRouteError = null
}

export function clearCcbRoute(): void {
  activeCcbRoute = null
  lastOmniRouteReceipt = null
  lastOmniRouteError = null
}

export function updateCcbRouteFromReceipt(
  receipt: OmniRouteReceipt,
  receiptPolicy: DirectRoute['receiptPolicy'],
): void {
  if (!activeCcbRoute) return
  if (receiptPolicy === 'none') {
    // Route C (9router/direct) does not parse receipts
    activeCcbRoute.proof = 'direct'
    return
  }
  // For A (omniroute/ccb-chat, CCB main) and B (omniroute/9router)
  if (receipt.provider && receipt.model) {
    // Verify if receipt contains explicit 9router evidence for route B
    const has9routerEvidence =
      receiptPolicy === 'omniroute-9router' &&
      (receipt.decision?.includes('9router') ||
        receipt.routingReason?.includes('9router') ||
        receipt.cognitivePool?.includes('9router') ||
        receipt.provider?.includes('9router') ||
        receipt.requestId?.includes('9router'))
    activeCcbRoute.provider = receipt.provider
    activeCcbRoute.model = receipt.model
    activeCcbRoute.proof = has9routerEvidence ? 'verified' : 'unverified'
  }
}

export function getRaceMetricPreferences(): ReadonlyMap<string, number> {
  // Server-side routing owns learning/ranking. Keep this compatibility shim
  // neutral; CCB must not resurrect a second local policy engine.
  return new Map()
}

export function recordRaceMetric(_metric: Record<string, unknown>): void {
  // Request outcome is already observed by OmniRoute from the gateway stream.
  // Deliberately no-op: no duplicate local JSONL ledger or client-side policy.
}

export function readFileTail(_path: string, _maxBytes?: number): string {
  return ''
}

// ── Error Classification ───────────────────────────────────────────

export type FailoverReason =
  | 'rate_limit'
  | 'quota_exceeded'
  | 'auth_invalid'
  | 'billing'
  | 'server_error'
  | 'timeout'
  | 'model_output'
  | 'network'
  | 'unknown'

export interface ErrorClassification {
  reason: FailoverReason
  status?: number
  retryable: boolean
  scope: 'provider' | 'model' | 'account'
}

export function isGatewayUnavailable(error: unknown): boolean {
  const status = (error as { status?: number } | undefined)?.status
  if (status !== 502 && status !== 503 && status !== 504) return false
  const message = String(
    (error as { message?: string } | undefined)?.message ?? '',
  )
  return /all gateway backends unavailable|gateway_unavailable|all configured gateway backends failed/i.test(
    message,
  )
}

export function classifyError(error: unknown): ErrorClassification {
  const status = (error as { status?: number } | undefined)?.status
  const message = String(
    (error as { message?: string } | undefined)?.message ?? '',
  ).toLowerCase()
  const name = (error as { name?: string } | undefined)?.name ?? ''

  if (name === 'ProviderOutputError')
    return { reason: 'model_output', retryable: false, scope: 'model' }
  if (isCreditExhausted401(status, message))
    return { reason: 'rate_limit', status, retryable: true, scope: 'account' }
  if (status === 401 || status === 403)
    return {
      reason: 'auth_invalid',
      status,
      retryable: false,
      scope: 'account',
    }
  if (status === 402 || /quota|balance|insufficient/.test(message))
    return {
      reason: 'quota_exceeded',
      status,
      retryable: false,
      scope: 'account',
    }
  if (status === 429 || /rate.?limit/i.test(message))
    return { reason: 'rate_limit', status, retryable: true, scope: 'account' }
  if (status && status >= 500)
    return {
      reason: 'server_error',
      status,
      retryable: true,
      scope: 'provider',
    }
  if (status && status >= 400)
    return { reason: 'model_output', status, retryable: false, scope: 'model' }
  if (/abort|timeout|timed.?out|deadline|eof|socket/.test(message))
    return { reason: 'timeout', retryable: true, scope: 'provider' }
  if (/econnrefused|enetunreach|eai_again|socket hang up/i.test(message))
    return { reason: 'network', retryable: true, scope: 'provider' }
  return { reason: 'unknown', retryable: true, scope: 'provider' }
}

/**
 * OmniRoute emits a 502 with code `gateway_unavailable`
 * once every model/port fallback is exhausted — the whole local account pool
 * is down. The pool recovers on its own once the backends restart, so CCB
 * treats this as a longer-retryable failure instead of a fatal provider error.
 */
export function isRetryable(error: unknown): boolean {
  return [
    'rate_limit',
    'server_error',
    'timeout',
    'network',
    'unknown',
  ].includes(classifyError(error).reason)
}

export function isPermanentError(error: unknown): boolean {
  return ['auth_invalid', 'billing', 'model_output', 'quota_exceeded'].includes(
    classifyError(error).reason,
  )
}
