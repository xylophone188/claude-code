import { getCachedCodexModels, hasAnyCodexAuth } from './codexModelDiscovery.js'
import type { ProviderConfig } from './providerRegistry/types.js'

/** The transport selected for a runtime projection. OAuth remains private to it. */
export type CodexRuntimeTransport = 'codex-responses'

export type CodexRuntimeProjection = {
  provider: ProviderConfig
  transport: CodexRuntimeTransport
}

function normalizeModels(models: readonly string[]): string[] {
  return [...new Set(models.map(model => model.trim()).filter(Boolean))]
}

/**
 * Build a provider projection from already-discovered Codex model metadata.
 *
 * This projection deliberately contains no credential material. The Responses
 * adapter obtains OAuth credentials through its existing auth boundary; the
 * provider registry only needs model discovery and a transport marker.
 */
export function createCodexRuntimeProjection(
  models: readonly string[],
): CodexRuntimeProjection | undefined {
  const normalizedModels = normalizeModels(models)
  if (normalizedModels.length === 0) return undefined

  return {
    provider: {
      id: 'codex',
      kind: 'openai-compat',
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      defaultModel: normalizedModels[0]!,
      models: normalizedModels,
      compatRule: 'permissive',
      noAuth: true,
    },
    transport: 'codex-responses',
  }
}

/**
 * Project the locally available Codex runtime into the provider registry.
 * Missing credentials or model metadata means there is no projection.
 */
export function loadCodexRuntimeProjection():
  | CodexRuntimeProjection
  | undefined {
  if (!hasAnyCodexAuth()) return undefined
  return createCodexRuntimeProjection(getCachedCodexModels())
}
