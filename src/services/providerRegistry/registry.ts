/**
 * ProviderBackendRegistry singleton.
 *
 * Selects the active ProviderBackend at startup and provides access to all
 * runtime callers. Initialized by bootstrapProviders() during startup.
 */

import type { ProviderBackend } from './backend.js'

let _backend: ProviderBackend | null = null

export const ProviderBackendRegistry = {
  /** Called ONCE at startup by bootstrapProviders(). */
  setBackend(backend: ProviderBackend): void {
    _backend = backend
  },

  /** Returns the active backend. Throws if not initialized. */
  getBackend(): ProviderBackend {
    if (!_backend) {
      throw new Error(
        'ProviderBackendRegistry not initialized. Call bootstrapProviders() before using loadProviders().',
      )
    }
    return _backend
  },

  /** Invalidates the active backend's cache. Called after saveProviders(). */
  invalidateCache(): void {
    _backend?.invalidateCache()
  },

  /** Checks if registry has been initialized. */
  isInitialized(): boolean {
    return _backend !== null
  },

  /** Test-only: reset the singleton so a fresh backend can be registered. */
  resetForTest(): void {
    _backend = null
  },
}
