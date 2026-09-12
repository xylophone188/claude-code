/**
 * catalogSync.ts — provider model-catalog synchronization for the CCB local
 * router.
 *
 * SenseNova and other OpenAI-compatible upstreams publish their model list at
 * GET /models. The candidates that `getAutoCandidateTiers()` resolves to are
 * a static fallback; this module keeps a live, TTL-cached catalog so that
 * renamed or retired models are detected instead of silently 404ing.
 *
 * The network boundary is injected — `syncProviderCatalog` takes a `fetcher`,
 * and everything else (shape validation, text-generation filtering, TTL,
 * atomic-style return) is deterministic and testable without a socket.
 * Nothing here ever persists credentials; the cache holds model ids only.
 */

export interface ProviderModelCatalog {
  providerId: string
  updatedAt: string
  models: string[]
}

export interface CatalogSyncOptions {
  /** Registry id, e.g. 'sensenova'. */
  providerId: string
  /** Models endpoint. Defaults to `${providerId}/models` for tests; the
   *  production wrapper supplies the real base URL. */
  endpoint: string
  /** Last known-good catalog. Retained when the fetch fails or returns
   *  nothing usable — a failed sync never empties a known-good list. */
  current?: ProviderModelCatalog
  now?: number
  ttlMs?: number
  fetcher?: typeof fetch
}

export const DEFAULT_CATALOG_TTL_MS = 8 * 60 * 60 * 1000

/** Modalities that disqualify a model id from text-generation routing. */
const NON_TEXT_MODALITY_RE =
  /(?:image|vision|video|audio|tts|transcri(?:be|ption)|embed|rerank)/i

/** Id patterns marking a vision/ocr model: `vl` or `ocr` as
 *  standalone tokens (e.g. `qwen-vl-max`, `gpt-vision`, `ocr-9b`). */
const VISION_ID_RE = /(?:^|[^a-z])(?:vl|ocr)(?:$|[^a-z])/i

/** Combined test: modality string or vision id pattern. */
function isNonTextId(id: string): boolean {
  return NON_TEXT_MODALITY_RE.test(id) || VISION_ID_RE.test(id)
}

/**
 * Extract text-generation model ids from an OpenAI-compatible /models body.
 * Accepts both `{ data: [{ id }] }` and `{ data: [string] }` shapes and
 * dedupes while preserving order.
 */
export function extractTextModels(payload: unknown): string[] {
  if (!payload || typeof payload !== 'object') return []
  const data = (payload as { data?: unknown }).data
  if (!Array.isArray(data)) return []
  const result: string[] = []
  for (const item of data) {
    if (typeof item === 'string') {
      if (item.trim() && !isNonTextId(item.trim())) result.push(item.trim())
      continue
    }
    if (!item || typeof item !== 'object') continue
    const record = item as Record<string, unknown>
    const id = typeof record.id === 'string' ? record.id.trim() : ''
    if (!id || isNonTextId(id)) continue
    const modalities = [
      record.modalities,
      record.inputModalities,
      record.outputModalities,
    ]
      .flatMap(value => (Array.isArray(value) ? value : []))
      .filter((value): value is string => typeof value === 'string')
      .join(' ')
    if (NON_TEXT_MODALITY_RE.test(modalities)) continue
    result.push(id)
  }
  return [...new Set(result)]
}

/** Whether the catalog is still usable (present, dated, and inside the TTL). */
export function catalogIsFresh(
  catalog: ProviderModelCatalog | undefined,
  now: number = Date.now(),
  ttlMs: number = DEFAULT_CATALOG_TTL_MS,
): boolean {
  if (!catalog || !catalog.updatedAt || !catalog.models.length) return false
  const updated = Date.parse(catalog.updatedAt)
  return Number.isFinite(updated) && updated <= now && now - updated < ttlMs
}

/**
 * Refresh a provider model catalog when the current value is missing or
 * stale. Fetch failures, non-2xx responses, malformed bodies, and empty
 * model lists all leave `current` untouched.
 */
export async function syncProviderModelCatalog(
  options: CatalogSyncOptions,
): Promise<ProviderModelCatalog | undefined> {
  const now = options.now ?? Date.now()
  const ttlMs = options.ttlMs ?? DEFAULT_CATALOG_TTL_MS
  if (catalogIsFresh(options.current, now, ttlMs)) return options.current
  const fetcher = options.fetcher ?? fetch
  try {
    const response = await fetcher(options.endpoint, {
      headers: { Accept: 'application/json' },
    })
    const payload: unknown = await response.json()
    const models = extractTextModels(payload)
    if (!response.ok || !models.length) return options.current
    return {
      providerId: options.providerId,
      updatedAt: new Date(now).toISOString(),
      models,
    }
  } catch {
    return options.current
  }
}

/** Merge a synced catalog with a static candidate list: live ids win, any
 *  id present in both is kept once, and static-only ids are retained when the
 *  catalog is missing so routing still has something to try. */
export function mergeCatalogWithStatic(
  catalog: ProviderModelCatalog | undefined,
  staticIds: string[],
): string[] {
  if (!catalog?.models.length) return [...staticIds]
  const merged = [...catalog.models]
  for (const id of staticIds) {
    if (!merged.includes(id)) merged.push(id)
  }
  return merged
}
