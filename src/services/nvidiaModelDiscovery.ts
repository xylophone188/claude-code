/** NVIDIA Model Discovery Service
 *  Fetches available models from https://integrate.api.nvidia.com/v1/models
 *  Caches results for 24 hours with invalidation when models are deprecated.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { routeLog, routeError } from './routing/stageLog.js'

const NVIDIA_MODELS_URL = 'https://integrate.api.nvidia.com/v1/models'
const NVIDIA_MODELS_CACHE_FILE =
  process.env.CCB_NVIDIA_MODELS_CACHE_FILE ??
  join(homedir(), '.ccb-embed', 'nvidia-models-cache.json')
const NVIDIA_MODELS_CACHE_TTL_MS = 24 * 60 * 60 * 1000

interface NvidiaModelsCache {
  updatedAt: string
  models: string[]
}

function readNvidiaModelsCache(): NvidiaModelsCache | undefined {
  try {
    if (!existsSync(NVIDIA_MODELS_CACHE_FILE)) return undefined
    const parsed = JSON.parse(
      readFileSync(NVIDIA_MODELS_CACHE_FILE, 'utf8'),
    ) as unknown
    if (!parsed || typeof parsed !== 'object') return undefined
    const record = parsed as Record<string, unknown>
    const updatedAt =
      typeof record.updatedAt === 'string' ? record.updatedAt : ''
    const models = Array.isArray(record.models)
      ? record.models
          .map(item => (typeof item === 'string' ? item.trim() : ''))
          .filter(Boolean)
      : []
    return updatedAt && models.length ? { updatedAt, models } : undefined
  } catch {
    return undefined
  }
}

export function getCachedNvidiaModels(): string[] {
  return readNvidiaModelsCache()?.models ?? []
}

export async function refreshNvidiaModelsCache(): Promise<void> {
  const cache = readNvidiaModelsCache()
  const cacheIsFresh =
    cache &&
    Date.now() - Date.parse(cache.updatedAt) < NVIDIA_MODELS_CACHE_TTL_MS

  if (cacheIsFresh) {
    // Check for model deprecation (previously cached models no longer in upstream)
    try {
      const currentModels = await fetchNvidiaModelsRaw()
      if (currentModels.length > 0) {
        const deprecatedModels = cache.models.filter(
          m => !currentModels.includes(m),
        )
        if (deprecatedModels.length > 0) {
          routeLog(
            'nvidia-discovery',
            `Detected deprecated models: ${deprecatedModels.join(', ')}. Refreshing cache.`,
          )
        } else {
          return // Cache is fresh and no models deprecated
        }
      }
    } catch {
      // If fetch fails, keep using stale cache
      return
    }
  }

  try {
    const models = await fetchNvidiaModelsRaw()
    if (!models.length) {
      throw new Error('NVIDIA models returned empty list')
    }
    writeFileSync(
      NVIDIA_MODELS_CACHE_FILE,
      `${JSON.stringify({ updatedAt: new Date().toISOString(), models })}\n`,
      { mode: 0o600 },
    )
    routeLog('nvidia-discovery', `NVIDIA models refreshed (${models.length})`)
  } catch (error) {
    routeError(
      'nvidia-discovery',
      `NVIDIA models refresh failed: ${String(error)}`,
    )
    throw error
  }
}

async function fetchNvidiaModelsRaw(): Promise<string[]> {
  const response = await fetch(NVIDIA_MODELS_URL, {
    headers: { Accept: 'application/json' },
  })
  const payload = (await response.json()) as { data?: unknown }
  const models = Array.isArray(payload.data)
    ? payload.data
        .map(item =>
          item && typeof item === 'object' && typeof item.id === 'string'
            ? item.id.trim()
            : '',
        )
        .filter(Boolean)
        .filter(
          model =>
            !/(?:image|video|audio|tts|transcri(?:be|ption)|embed)/i.test(
              model,
            ),
        )
    : []
  if (!response.ok || !models.length) {
    throw new Error(`NVIDIA models returned HTTP ${response.status}`)
  }
  return models
}

export function clearNvidiaModelsCache(): void {
  try {
    if (existsSync(NVIDIA_MODELS_CACHE_FILE)) {
      // Note: we don't actually delete to preserve for fallback, but we could
      // For now, just log
      routeLog('nvidia-discovery', 'Cache clear requested (not implemented)')
    }
  } catch {
    // ignore
  }
}
