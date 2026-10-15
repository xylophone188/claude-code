/**
 * ProviderBackend interface and implementations for Phase 3.3.
 *
 * Supports both Legacy (providers.json) and ResourcePlane backends.
 * The BackendRegistry singleton selects one at startup based on CCB_RESOURCE_PLANE.
 */

import type { ProviderConfig } from './types.js'
import {
  loadProvidersFromResourcePlane,
  resolveTransportCredential,
} from '../resourcePlane/readAdapter.js'
import { loadProvidersLegacyRaw, _invalidateProviderCache } from './loader.js'

// ── ProviderBackend interface ─────────────────────────────────────────────────

export interface ProviderBackend {
  /** Synchronous read — MUST not do I/O. Returns cached data. */
  loadProvidersSync(): ProviderConfig[]

  /** Async warm — called ONCE at startup. Populates internal cache. */
  warmCache(): Promise<void>

  /** Invalidate cache — called after saveProviders() or on demand. */
  invalidateCache(): void

  /** Optional: single-credential resolution at transport boundary. */
  resolveCredential?(
    providerId: string,
    accountId: string,
  ): Promise<string | undefined>
}

// ── LegacyBackend: reads providers.json + built-ins (current behavior) ────────

export class LegacyBackend implements ProviderBackend {
  private _cachedProviders: ProviderConfig[] | null = null

  loadProvidersSync(): ProviderConfig[] {
    if (this._cachedProviders !== null) return this._cachedProviders
    this._cachedProviders = loadProvidersLegacyRaw()
    return this._cachedProviders
  }

  warmCache(): Promise<void> {
    return Promise.resolve()
  }

  invalidateCache(): void {
    this._cachedProviders = null
    _invalidateProviderCache()
  }
}

// ── ResourcePlaneBackend: reads from PG resource_plane.* tables ───────────────

export class ResourcePlaneBackend implements ProviderBackend {
  private _cachedProviders: ProviderConfig[] | null = null
  private _cacheLoadedAt = 0
  private static readonly CACHE_TTL_MS = 30_000

  loadProvidersSync(): ProviderConfig[] {
    const now = Date.now()
    if (
      this._cachedProviders &&
      now - this._cacheLoadedAt < ResourcePlaneBackend.CACHE_TTL_MS
    ) {
      return [...this._cachedProviders]
    }
    // Fallback to empty array if not warmed — callers handle gracefully
    if (!this._cachedProviders) return []
    return [...this._cachedProviders]
  }

  async warmCache(): Promise<void> {
    try {
      const rpProviders = await loadProvidersFromResourcePlane({
        decryptCredentials: false,
      })
      this._cachedProviders = rpProviders
      this._cacheLoadedAt = Date.now()
    } catch {
      this._cachedProviders = []
      this._cacheLoadedAt = Date.now()
    }
  }

  invalidateCache(): void {
    this._cachedProviders = null
    this._cacheLoadedAt = 0
  }

  async resolveCredential(
    providerId: string,
    accountId: string,
  ): Promise<string | undefined> {
    return resolveTransportCredential(providerId, accountId)
  }
}
