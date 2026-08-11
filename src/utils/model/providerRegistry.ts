import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Home directory, read at call time: `os.homedir()` caches its value at
 *  startup in Bun, so tests overriding process.env.HOME would be ignored
 *  without this fallback. */
const homeDir = (): string => process.env.HOME ?? homedir()

/** A provider the user explicitly added via the /model picker's "添加供应商"
 *  flow, persisted at ~/.ccb/providers.json. */
export interface RegisteredProvider {
  id: string
  providerId: string
  name: string
  addedAt: string
  /** True when the provider is disabled — hidden from the "已接入" list. */
  disabled?: boolean
  /** Disabled model ids for this provider (e.g. ["openrouter/meta-llama"]).
   *  Missing/empty array means all models enabled. */
  disabledModels?: string[]
  /** OpenAI-compatible base URL for user-added custom endpoints. Absent for
   *  providers picked from CCB's embedded catalog. */
  baseUrl?: string
  /** API key for the custom endpoint. Absent for catalog-backed providers. */
  apiKey?: string
  /** Model ids probed from `GET {baseUrl}/models` at registration time. */
  models?: string[]
}

const REGISTRY_DIR = () => join(homeDir(), '.ccb')
const REGISTRY_PATH = () => join(REGISTRY_DIR(), 'providers.json')

function isRegisteredProvider(value: unknown): value is RegisteredProvider {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Record<string, unknown>
  return (
    typeof entry.id === 'string' &&
    typeof entry.providerId === 'string' &&
    typeof entry.name === 'string' &&
    typeof entry.addedAt === 'string'
  )
}

/** Registered providers in insertion order. Missing/unreadable registry
 *  yields an empty array (fail-open, never throws). */
export function getRegisteredProviders(): RegisteredProvider[] {
  try {
    if (!existsSync(REGISTRY_PATH())) return []
    const raw = readFileSync(REGISTRY_PATH(), 'utf8')
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(isRegisteredProvider)
  } catch {
    return []
  }
}

/** Persist the registry; I/O failures degrade silently. */
function writeRegistry(entries: RegisteredProvider[]): boolean {
  try {
    mkdirSync(REGISTRY_DIR(), { recursive: true })
    writeFileSync(REGISTRY_PATH(), JSON.stringify(entries, null, 2), 'utf8')
    return true
  } catch {
    return false
  }
}

/** Add a provider by idempotent providerId (duplicates are skipped). Returns
 *  the full updated list. */
export function addRegisteredProvider(entry: {
  providerId: string
  name: string
}): RegisteredProvider[] {
  const current = getRegisteredProviders()
  if (current.some(p => p.providerId === entry.providerId)) return current
  const next = [
    ...current,
    { ...entry, id: randomUUID(), addedAt: new Date().toISOString() },
  ]
  writeRegistry(next)
  return next
}

/** Remove a provider by its registry id. */
export function removeRegisteredProvider(id: string): void {
  writeRegistry(getRegisteredProviders().filter(p => p.id !== id))
}

/** Flip the disabled bit for a provider by registry id. Pass baseUrl/apiKey
 *  through unchanged. Returns the updated list. */
export function setProviderDisabled(
  id: string,
  disabled: boolean,
): RegisteredProvider[] {
  const next = getRegisteredProviders().map(p =>
    p.id === id ? { ...p, disabled } : p,
  )
  writeRegistry(next)
  return next
}

/** Toggle the disabled bit from its current value. */
export function toggleProviderDisabled(id: string): RegisteredProvider[] {
  const current = getRegisteredProviders().find(p => p.id === id)
  return setProviderDisabled(id, !current?.disabled)
}

/** Rename a provider by registry id. */
export function renameRegisteredProvider(id: string, name: string): void {
  const trimmed = name.trim()
  if (!trimmed) return
  writeRegistry(
    getRegisteredProviders().map(p =>
      p.id === id ? { ...p, name: trimmed } : p,
    ),
  )
}

/** Register a custom endpoint provider with an OpenAI-compatible base URL and
 *  key, plus the model ids probed at registration time. */
export function addCustomEndpointProvider(entry: {
  name: string
  baseUrl: string
  apiKey?: string
  providerId: string
  models: string[]
}): RegisteredProvider[] {
  const current = getRegisteredProviders()
  if (current.some(p => p.providerId === entry.providerId)) return current
  const next = [
    ...current,
    {
      ...entry,
      id: randomUUID(),
      addedAt: new Date().toISOString(),
    },
  ]
  writeRegistry(next)
  return next
}

/** Toggle a single model id within a provider's disabledModels list. Returns
 *  the updated registry list. */
export function toggleProviderModel(
  providerId: string,
  model: string,
): RegisteredProvider[] {
  const next = getRegisteredProviders().map(p => {
    if (p.providerId !== providerId) return p
    const disabled = p.disabledModels ?? []
    const has = disabled.includes(model)
    return {
      ...p,
      disabledModels: has
        ? disabled.filter(m => m !== model)
        : [...disabled, model],
    }
  })
  writeRegistry(next)
  return next
}

/** Display name for CCB's built-in provider list. */
export function getLocalGatewayName(): string {
  const ccb = getRegisteredProviders().find(p => p.providerId === 'ccb')
  return ccb?.name ?? '本地供应商'
}

/** Rename CCB's built-in provider entry. */
export function setLocalGatewayName(name: string): void {
  const current = getRegisteredProviders()
  const index = current.findIndex(p => p.providerId === 'ccb')
  const next =
    index >= 0
      ? current.map((p, i) => (i === index ? { ...p, name } : p))
      : [
          ...current,
          {
            id: randomUUID(),
            providerId: 'ccb',
            name,
            addedAt: new Date().toISOString(),
          },
        ]
  writeRegistry(next)
}
