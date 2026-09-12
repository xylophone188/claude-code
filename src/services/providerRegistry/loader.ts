import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { homedir } from 'node:os'
import { join } from 'path'
import { randomBytes } from 'node:crypto'
import { tmpdir } from 'node:os'
import { parse as parseYaml } from 'yaml'
import { logError } from '../../utils/log.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { ProvidersFileSchema, type ProviderConfig } from './types.js'
import { EMBEDDED_PROVIDERS } from './embeddedProviders.generated.js'
import { CCB_ROUTING_PROVIDERS } from '../routing/registry.generated.js'
import { readCodeBuddyCnPoolSync } from '../api/openai/codebuddyCnAuth.js'

/**
 * The four built-in OpenAI-compat providers.
 *
 * These are used when providers.json is absent or contains no entries.
 * User-defined providers in ~/.claude/providers.json are merged on top
 * (they replace a built-in with the same id).
 */
export const DEFAULT_PROVIDERS: ProviderConfig[] = [
  {
    id: 'cerebras',
    kind: 'openai-compat',
    baseUrl: 'https://api.cerebras.ai/v1',
    apiKeyEnv: 'CEREBRAS_API_KEY',
    defaultModel: 'gpt-oss-120b',
    models: ['gpt-oss-120b', 'gemma-4-31b', 'qwen-3.8-27b'],
    compatRule: 'cerebras',
  },
  {
    id: 'groq',
    kind: 'openai-compat',
    baseUrl: 'https://api.groq.com/openai/v1',
    apiKeyEnv: 'GROQ_API_KEY',
    defaultModel: 'llama-3.3-70b-versatile',
    compatRule: 'groq',
  },
  {
    id: 'qwen',
    kind: 'openai-compat',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    apiKeyEnv: 'DASHSCOPE_API_KEY',
    defaultModel: 'qwen-max',
    compatRule: 'strict-openai',
  },
  {
    id: 'deepseek',
    kind: 'openai-compat',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    defaultModel: 'deepseek-chat',
    compatRule: 'deepseek',
  },
]

/**
 * Providers derived from the in-repo ccb registry (CCB_ROUTING_PROVIDERS).
 *
 * Each upstream provider is namespaced under `ccb/` so it cannot clash
 * with the core defaults or Embedded ids, and is reshaped into a
 * ProviderConfig. `compatRule` defaults to 'permissive' (the ccb registry
 * only emits 'permissive' | 'strict'); `apiKeyEnv` falls back to
 * OPENAI_API_KEY when an upstream entry omits it.
 */
export const EMBEDDED_ROUTING_PROVIDERS: ProviderConfig[] =
  CCB_ROUTING_PROVIDERS.map(p => ({
    id: `ccb/${p.id}`,
    kind: 'openai-compat' as const,
    baseUrl: p.baseUrl,
    apiKeyEnv: p.apiKeyEnv ?? 'OPENAI_API_KEY',
    defaultModel: p.defaultModel ?? '',
    compatRule: (p.compatRule ?? 'permissive') as ProviderConfig['compatRule'],
  }))

type CcbEmbedModelLike = string | { id?: unknown; name?: unknown }
type CcbEmbedProvider = {
  id?: unknown
  baseUrl?: unknown
  autoModel?: unknown
  autoModels?: unknown
  models?: unknown
  defaultModel?: unknown
  keys?: unknown
  oauth?: unknown
  defaultHeaders?: unknown
  timeoutMs?: unknown
}

/**
 * CCB's credential store is authoritative for its direct-route pool.  Import
 * only valid OpenAI-compatible entries, keep credentials in memory, and never
 * report their values.  ~/.claude/providers.json still overrides this source.
 */
export function loadCcbEmbedProviders(): ProviderConfig[] {
  const filePath =
    process.env.CCB_EMBED_PROVIDERS_FILE ??
    join(homedir(), '.ccb-embed', 'providers.json')
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as {
      providers?: unknown
    }
    if (!Array.isArray(parsed.providers)) return []
    // Embedded/default providers supply the canonical id/kind/baseUrl/models/
    // headers for each known provider. ccb-embed entries contribute the live
    // credentials (keys/oauth). We MERGE creds into the base so a provider keeps
    // its models/defaultModel/headers even when the ccb-embed entry omits them
    // (which is the normal case — only credentials live in ccb-embed).
    const baseById = new Map<string, ProviderConfig>()
    for (const p of [...EMBEDDED_PROVIDERS, ...DEFAULT_PROVIDERS]) {
      baseById.set(p.id, p)
    }
    return parsed.providers.flatMap(raw => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return []
      const provider = raw as CcbEmbedProvider
      const id = typeof provider.id === 'string' ? provider.id.trim() : ''
      if (!/^[a-z0-9][a-z0-9:_-]*$/.test(id)) return []
      const base = baseById.get(id)
      const ccbBaseUrl =
        typeof provider.baseUrl === 'string' ? provider.baseUrl.trim() : ''
      // ccb-embed baseUrls occasionally include the endpoint path (e.g.
      // `…/v1/chat/completions`); strip it so the URL is the API root and the
      // caller appends the path. Mirrors normalizeBaseURL() in directRouter.
      const stripEndpoint = (url: string): string =>
        url.replace(/\/(?:chat\/completions|responses|models)\/?$/, '')
      const effectiveBaseUrl = /^https?:\/\//i.test(ccbBaseUrl)
        ? stripEndpoint(ccbBaseUrl)
        : stripEndpoint(base?.baseUrl ?? '')
      if (!/^https?:\/\//i.test(effectiveBaseUrl)) return []
      const normalizeModel = (value: unknown): string => {
        const model =
          typeof value === 'string'
            ? value.trim()
            : value && typeof value === 'object' && 'id' in value
              ? String((value as { id?: unknown }).id ?? '').trim()
              : ''
        return model.startsWith(`${id}/`) ? model.slice(id.length + 1) : model
      }
      const models = Array.from(
        new Set(
          [
            normalizeModel(provider.autoModel),
            ...(Array.isArray(provider.autoModels)
              ? provider.autoModels.map(normalizeModel)
              : []),
            ...(Array.isArray(provider.models)
              ? (provider.models as CcbEmbedModelLike[]).map(normalizeModel)
              : []),
          ].filter(Boolean),
        ),
      )
      const keys = Array.isArray(provider.keys)
        ? provider.keys
            .filter(
              (key): key is string => typeof key === 'string' && Boolean(key),
            )
            .map((apiKey, index) => ({ id: `ccb-key-${index + 1}`, apiKey }))
        : []
      const oauth = Array.isArray(provider.oauth)
        ? provider.oauth.flatMap((entry, index) => {
            if (!entry || typeof entry !== 'object' || Array.isArray(entry))
              return []
            const record = entry as Record<string, unknown>
            const apiKey =
              typeof record.accessToken === 'string'
                ? record.accessToken
                : typeof record.access_token === 'string'
                  ? record.access_token
                  : ''
            return apiKey ? [{ id: `ccb-oauth-${index + 1}`, apiKey }] : []
          })
        : []
      // No credentials → nothing to contribute; the embedded base (models only,
      // no accounts) already covers this provider. Skip to avoid clobbering it.
      if (!keys.length && !oauth.length) return []
      const mergedModels = models.length ? models : (base?.models ?? [])
      const mergedDefaultModel = models[0] ?? base?.defaultModel ?? ''
      const headers =
        provider.defaultHeaders &&
        typeof provider.defaultHeaders === 'object' &&
        !Array.isArray(provider.defaultHeaders)
          ? Object.fromEntries(
              Object.entries(provider.defaultHeaders).filter(
                ([, value]) => typeof value === 'string',
              ),
            )
          : base?.headers
      const timeoutMs =
        typeof provider.timeoutMs === 'number' &&
        Number.isInteger(provider.timeoutMs) &&
        provider.timeoutMs > 0
          ? provider.timeoutMs
          : base?.timeoutMs
      return [
        {
          ...base,
          id,
          kind: (base?.kind ?? 'openai-compat') as ProviderConfig['kind'],
          baseUrl: effectiveBaseUrl,
          defaultModel: mergedDefaultModel,
          models: mergedModels,
          accounts: [...keys, ...oauth],
          compatRule: base?.compatRule ?? 'permissive',
          ...(headers && Object.keys(headers).length ? { headers } : {}),
          ...(timeoutMs ? { timeoutMs } : {}),
        },
      ]
    })
  } catch {
    return []
  }
}

/** Read Hermes Agent's legacy list and v12 provider dictionary without importing Hermes. */
export function loadHermesProviders(): ProviderConfig[] {
  try {
    const home =
      process.env.HERMES_HOME ?? join(process.env.HOME ?? '', '.hermes')
    const path = join(home, 'config.yaml')
    if (!existsSync(path)) return []
    const raw = parseYaml(readFileSync(path, 'utf8')) as Record<string, unknown>
    const entries: Array<{ key?: string; value: unknown }> = [
      ...(Array.isArray(raw.custom_providers)
        ? raw.custom_providers.map(value => ({ value }))
        : []),
      ...(raw.providers &&
      typeof raw.providers === 'object' &&
      !Array.isArray(raw.providers)
        ? Object.entries(raw.providers as Record<string, unknown>).map(
            ([key, value]) => ({ key, value }),
          )
        : []),
    ]
    const seen = new Set<string>()
    return entries.flatMap(({ key, value }) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return []
      const item = value as Record<string, unknown>
      const id = String(item.name ?? key ?? '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, '-')
      const baseUrl = String(
        item.base_url ?? item.baseUrl ?? item.api ?? item.url ?? '',
      ).trim()
      if (!id || !baseUrl || !/^https?:\/\//i.test(baseUrl)) return []
      const identity = `${id}|${baseUrl.replace(/\/+$/, '').toLowerCase()}`
      if (seen.has(identity)) return []
      seen.add(identity)
      const model =
        String(
          item.model ?? item.default_model ?? item.defaultModel ?? '',
        ).trim() ||
        (item.models &&
        typeof item.models === 'object' &&
        !Array.isArray(item.models)
          ? (Object.keys(item.models as Record<string, unknown>)[0] ?? '')
          : Array.isArray(item.models)
            ? String(item.models[0] ?? '')
            : '')
      if (!model) return []
      const keyEnv = String(
        item.key_env ?? item.api_key_env ?? item.apiKeyEnv ?? '',
      ).trim()
      const apiKey = String(item.api_key ?? item.apiKey ?? '').trim()
      const rawHeaders = item.headers ?? item.extra_headers
      const headers =
        rawHeaders &&
        typeof rawHeaders === 'object' &&
        !Array.isArray(rawHeaders)
          ? (Object.fromEntries(
              Object.entries(rawHeaders).filter(
                ([, v]) => typeof v === 'string',
              ),
            ) as Record<string, string>)
          : undefined
      return [
        {
          id: `hermes/${id}`,
          kind: 'openai-compat' as const,
          baseUrl,
          ...(keyEnv ? { apiKeyEnv: keyEnv } : {}),
          ...(apiKey ? { apiKey } : {}),
          defaultModel: model,
          compatRule: 'permissive' as const,
          ...(Array.isArray(item.models)
            ? {
                models: item.models.filter(
                  (value): value is string =>
                    typeof value === 'string' && Boolean(value.trim()),
                ),
              }
            : item.models &&
                typeof item.models === 'object' &&
                !Array.isArray(item.models)
              ? { models: Object.keys(item.models as Record<string, unknown>) }
              : {}),
          ...(headers && Object.keys(headers).length ? { headers } : {}),
        },
      ]
    })
  } catch {
    return []
  }
}

/**
 * All built-in providers: the four core defaults, the Embedded collection of
 * ccb openai-compat providers, and the in-repo ccb provider set.
 *
 * Deduplicated by id with core defaults winning — Embedded's cerebras/groq/
 * deepseek entries (CCB_*_KEY env) only fill gaps, never override the core
 * defaults' credential expectations. CCBRouting ids are namespaced (`ccb/…`)
 * so they never clash.
 */
export const BUILTIN_PROVIDERS: ProviderConfig[] = [
  ...new Map(
    [
      ...EMBEDDED_PROVIDERS,
      ...DEFAULT_PROVIDERS,
      ...EMBEDDED_ROUTING_PROVIDERS,
      ...loadCcbEmbedProviders(),
      ...loadHermesProviders(),
    ].map(p => [p.id, p]),
  ).values(),
]

/**
 * Returns the path to the providers.json file in the Claude config directory.
 */
export function getProvidersFilePath(): string {
  return join(getClaudeConfigHomeDir(), 'providers.json')
}

// ── J1: per-process memoization with stale-on-invalidate ─────────────────────

let _cachedProviders: ProviderConfig[] | null = null

/** Invalidate the in-process provider cache (called after saveProviders). */
export function _invalidateProviderCache(): void {
  _cachedProviders = null
}

/**
 * Load provider configurations.
 *
 * Strategy:
 * 1. Start with DEFAULT_PROVIDERS.
 * 2. If ~/.claude/providers.json exists, parse and validate it with Zod.
 *    - Valid entries replace defaults with matching id; new ids are appended.
 *    - Corrupt/invalid file: log warning, return defaults only.
 * 3. Empty providers.json: return defaults.
 *
 * A1 fix: returns load diagnostics so callers (ProviderView) can surface errors.
 * J1 fix: memoized per-process; invalidated after saveProviders().
 *
 * This function never throws — corrupt files produce a warning + fallback.
 */
export function loadProviders(): ProviderConfig[] {
  // J1: return cached result if available (prevents repeated disk reads on findProvider)
  if (_cachedProviders !== null) return _cachedProviders

  const result = _loadProvidersInternal()
  _cachedProviders = result.providers
  return result.providers
}

/**
 * Load providers with diagnostic information.
 * Returns { providers, error? } — callers can surface the error to the UI.
 * A1 fix: exposes parse errors to UI layer instead of only logError.
 */
export function loadProvidersWithDiagnostic(): {
  providers: ProviderConfig[]
  error?: string
} {
  const result = _loadProvidersInternal()
  _cachedProviders = result.providers
  return result
}

function _loadProvidersInternal(): {
  providers: ProviderConfig[]
  error?: string
} {
  const filePath = getProvidersFilePath()

  if (!existsSync(filePath)) {
    return { providers: injectCodeBuddyCnAccounts([...BUILTIN_PROVIDERS]) }
  }

  let raw: string
  try {
    raw = readFileSync(filePath, 'utf-8')
  } catch (err: unknown) {
    const msg = `loadProviders: failed to read ${filePath}: ${err instanceof Error ? err.message : String(err)}`
    logError(new Error(msg))
    return {
      providers: injectCodeBuddyCnAccounts([...BUILTIN_PROVIDERS]),
      error: msg,
    }
  }

  // Empty file → return defaults
  if (!raw.trim()) {
    return { providers: injectCodeBuddyCnAccounts([...BUILTIN_PROVIDERS]) }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    const msg = `loadProviders: ${filePath} is not valid JSON. Using default providers.`
    logError(new Error(msg))
    return {
      providers: injectCodeBuddyCnAccounts([...BUILTIN_PROVIDERS]),
      error: msg,
    }
  }

  const result = ProvidersFileSchema.safeParse(parsed)
  if (!result.success) {
    const msg = `loadProviders: ${filePath} failed schema validation: ${result.error.message}. Using default providers.`
    logError(new Error(msg))
    return {
      providers: injectCodeBuddyCnAccounts([...BUILTIN_PROVIDERS]),
      error: msg,
    }
  }

  if (result.data.length === 0) {
    return { providers: injectCodeBuddyCnAccounts([...BUILTIN_PROVIDERS]) }
  }

  // Merge: user entries override defaults with same id; new ids are appended.
  const merged = new Map<string, ProviderConfig>()
  for (const p of BUILTIN_PROVIDERS) {
    merged.set(p.id, p)
  }
  for (const p of result.data) {
    merged.set(p.id, p)
  }

  return { providers: injectCodeBuddyCnAccounts(Array.from(merged.values())) }
}

/**
 * Inject aggregated CodeBuddy CN accounts (from the local pool, populated by
 * `import-9router` / device-flow login) into the codebuddy-cn provider's
 * `accounts[]` so chooseAccounts() round-robins them. No-op when the pool is
 * empty (provider keeps falling back to CCB_CODEBUDDY_CN_KEY).
 */
function injectCodeBuddyCnAccounts(
  providers: ProviderConfig[],
): ProviderConfig[] {
  const pool = readCodeBuddyCnPoolSync()
  if (!pool.length) return providers
  return providers.map(p =>
    p.id === 'codebuddy-cn'
      ? {
          ...p,
          accounts: pool.map(t => ({
            id: t.accountId,
            apiKey: t.accessToken,
          })),
        }
      : p,
  )
}

/**
 * Find a provider by id in the loaded list. Returns undefined if not found.
 */
export function findProvider(
  id: string,
  providers?: ProviderConfig[],
): ProviderConfig | undefined {
  return (providers ?? loadProviders()).find(p => p.id === id)
}

/**
 * Deep-equal comparison for ProviderConfig objects, key-order independent.
 * E4 fix: replaces JSON.stringify comparison which is key-order sensitive.
 */
function providerConfigEqual(a: ProviderConfig, b: ProviderConfig): boolean {
  const keysA = Object.keys(a).sort()
  const keysB = Object.keys(b).sort()
  if (keysA.length !== keysB.length) return false
  for (const k of keysA) {
    if (a[k as keyof ProviderConfig] !== b[k as keyof ProviderConfig])
      return false
  }
  return true
}

/**
 * Write additional providers to ~/.claude/providers.json.
 *
 * Only writes providers that are NOT already in DEFAULT_PROVIDERS (or the
 * existing file). If a provider with the same id exists, it is replaced.
 *
 * C3 fix: uses atomic tmp+rename write.
 * E4 fix: uses key-order-independent deep equal for default comparison.
 * J1 fix: invalidates cache after write.
 *
 * Returns the final merged list that was written.
 */
export function saveProviders(providers: ProviderConfig[]): ProviderConfig[] {
  const filePath = getProvidersFilePath()

  // Build merged list (providers override defaults by id)
  const merged = new Map<string, ProviderConfig>()
  for (const p of BUILTIN_PROVIDERS) {
    merged.set(p.id, p)
  }
  for (const p of providers) {
    merged.set(p.id, p)
  }

  // Only persist non-default providers (defaults are always built in)
  const toWrite: ProviderConfig[] = []
  for (const [id, p] of merged) {
    const isDefault = DEFAULT_PROVIDERS.some(d => d.id === id)
    if (!isDefault) {
      toWrite.push(p)
    } else {
      // E4: If user overrode a default, persist the override (key-order-independent compare)
      const defaultEntry = DEFAULT_PROVIDERS.find(d => d.id === id)
      if (defaultEntry && !providerConfigEqual(defaultEntry, p)) {
        toWrite.push(p)
      }
    }
  }

  // C3: atomic write — tmp file + rename prevents lost-update on concurrent save
  const tmpPath = join(
    tmpdir(),
    `.providers-${randomBytes(8).toString('hex')}.tmp`,
  )
  try {
    writeFileSync(tmpPath, JSON.stringify(toWrite, null, 2), 'utf-8')
    renameSync(tmpPath, filePath)
  } catch (err) {
    try {
      renameSync(tmpPath, tmpPath + '.cleanup')
    } catch {
      /* ignore */
    }
    throw err
  }

  // J1: invalidate cache so next loadProviders() reads fresh data
  _invalidateProviderCache()

  return Array.from(merged.values())
}
