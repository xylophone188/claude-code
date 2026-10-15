/**
 * Phase 3.3: Synchronous startup initialization for ProviderBackendRegistry.
 *
 * Called once at process startup (cli.tsx, embedServer.ts) AFTER warmPoolRegistry()
 * and init(). Selects the active ProviderBackend based on CCB_RESOURCE_PLANE feature flag.
 *
 * Security invariant: resourcePlane initialization happens only in startup path,
 * never at request time. After this function completes, loadProviders() is PURE SYNC.
 */

import { ProviderBackendRegistry } from '../providerRegistry/registry.js'
import {
  LegacyBackend,
  ResourcePlaneBackend,
} from '../providerRegistry/backend.js'
import { logForDebugging } from '../../utils/debug.js'

export async function bootstrapProviders(): Promise<void> {
  const useResourcePlane = process.env.CCB_RESOURCE_PLANE === '1'

  if (useResourcePlane) {
    logForDebugging('[bootstrap] Using ResourcePlane backend')
    const backend = new ResourcePlaneBackend()
    await backend.warmCache()
    ProviderBackendRegistry.setBackend(backend)
  } else {
    logForDebugging('[bootstrap] Using Legacy backend (providers.json)')
    const backend = new LegacyBackend()
    backend.warmCache() // no-op, but keeps interface consistent
    ProviderBackendRegistry.setBackend(backend)
  }
}
