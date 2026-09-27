/**
 * Phase 3.5: Unified API layer for ResourcePlane.
 *
 * Provides a consistent interface for all ResourcePlane operations:
 *  - Provider management (CRUD)
 *  - Credential lifecycle (rotation, expiration)
 *  - Sync operations (multi-node)
 *  - Monitoring (metrics, health)
 */

import type { ProviderConfig } from '../providerRegistry/types.js'
import { syncToResourcePlane } from './writeAdapter.js'
import { loadProvidersFromResourcePlane } from './readAdapter.js'
import { SyncEngine, getSyncEngine, resetSyncEngineForTest as resetSyncEngine } from './syncEngine.js'
import {
  CredentialRotation,
  CredentialExpirationManager,
  CredentialAudit,
  getLifecycleMetrics,
  type CredentialRotationInput,
  type CredentialExpirationCheck,
  type CredentialAuditEntry,
} from './credentialLifecycle.js'
import { getMetricsCollector, getHealthChecker, resetMonitoringForTest } from './monitoring.js'
import type {
  ResourceAuthType,
  ResourceSecretType,
  CredentialSecretValue,
} from './types.js'

// ── API Interface ─────────────────────────────────────────────────────────────

export interface ResourcePlaneApiOptions {
  nodeId?: string
  fencingEpoch?: number
  autoStartSync?: boolean
  syncPollIntervalMs?: number
}

// ── Unified API ───────────────────────────────────────────────────────────────

export class ResourcePlaneApi {
  private readonly syncEngine: SyncEngine
  private readonly options: ResourcePlaneApiOptions

  constructor(options: ResourcePlaneApiOptions = {}) {
    this.options = options
    this.syncEngine = new SyncEngine({
      nodeId: options.nodeId,
      fencingEpoch: options.fencingEpoch,
      syncPollIntervalMs: options.syncPollIntervalMs,
    })
  }

  // ── Provider Management ───────────────────────────────────────────────────

  /**
   * Load providers from ResourcePlane (metadata-only, credentials encrypted).
   */
  async loadProviders(options?: { decryptCredentials?: boolean }): Promise<ProviderConfig[]> {
    return loadProvidersFromResourcePlane({
      decryptCredentials: options?.decryptCredentials ?? false,
    })
  }

  /**
   * Sync providers to ResourcePlane (full reconciliation).
   */
  async syncProviders(providers: ProviderConfig[]): Promise<{
    accountsUpserted: number
    accountsDeleted: number
    credentialsUpserted: number
    credentialsDeleted: number
    capabilitiesUpserted: number
    capabilitiesDeleted: number
  }> {
    return syncToResourcePlane(providers, {
      ownerNodeId: this.options.nodeId,
      revision: Date.now(),
    })
  }

  // ── Credential Lifecycle ──────────────────────────────────────────────────

  /**
   * Rotate a single credential.
   */
  async rotateCredential(input: CredentialRotationInput): Promise<{
    newKeyVersion: number
    success: boolean
  }> {
    try {
      const result = await CredentialRotation.rotate(input)
      return { newKeyVersion: result.newKeyVersion, success: true }
    } catch (err) {
      return { newKeyVersion: 0, success: false }
    }
  }

  /**
   * Check for expiring credentials.
   */
  async checkExpiringCredentials(hoursThreshold?: number): Promise<CredentialExpirationCheck[]> {
    return CredentialExpirationManager.checkExpiringCredentials(hoursThreshold)
  }

  /**
   * Renew a credential expiration.
   */
  async renewCredentialExpiration(
    providerId: string,
    accountId: string,
    secretType: string,
    additionalDays?: number,
  ): Promise<boolean> {
    return CredentialExpirationManager.renewExpiration(
      providerId,
      accountId,
      secretType,
      additionalDays,
    )
  }

  /**
   * Auto-expire expired credentials.
   */
  async expireCredentials(): Promise<number> {
    return CredentialExpirationManager.expireCredentials()
  }

  /**
   * Get credential audit log.
   */
  async getAuditLog(providerId?: string, limit?: number): Promise<CredentialAuditEntry[]> {
    return CredentialAudit.getAuditLog(providerId, limit)
  }

  /**
   * Log a credential audit entry.
   */
  async logAudit(entry: Omit<CredentialAuditEntry, 'performedAt'>): Promise<void> {
    await CredentialAudit.log(entry)
  }

  // ── Cross-Service Sync ────────────────────────────────────────────────────

  /**
   * Start the sync engine.
   */
  async startSync(): Promise<void> {
    await this.syncEngine.start()
  }

  /**
   * Stop the sync engine.
   */
  async stopSync(): Promise<void> {
    await this.syncEngine.stop()
  }

  /**
   * Register a node.
   */
  async registerNode(nodeId: string, lastRevision: number): Promise<void> {
    await this.syncEngine.registerNode({
      nodeId,
      lastRevision,
      lastSyncedAt: new Date(),
      status: 'healthy',
      fencingEpoch: this.options.fencingEpoch ?? 0,
    })
  }

  /**
   * List all registered nodes.
   */
  async listNodes(): Promise<Array<{ nodeId: string; status: string; lastRevision: number }>> {
    const nodes = await this.syncEngine.listNodes()
    return nodes.map(n => ({
      nodeId: n.nodeId,
      status: n.status,
      lastRevision: n.lastRevision,
    }))
  }

  // ── Monitoring ────────────────────────────────────────────────────────────

  /**
   * Get current metrics.
   */
  async getMetrics() {
    const collector = getMetricsCollector()
    return collector.collectMetrics()
  }

  /**
   * Get health status.
   */
  async getHealth(): Promise<{
    overall: 'healthy' | 'degraded' | 'unhealthy'
    checks: Array<{ component: string; status: string; details?: string }>
  }> {
    const checker = getHealthChecker()
    const results = await checker.checkAll()
    const overall = checker.getOverallStatus(results)
    return {
      overall,
      checks: [...results.values()].map(r => ({
        component: r.component,
        status: r.status,
        details: r.details,
      })),
    }
  }

  /**
   * Get sync engine metrics.
   */
  getSyncMetrics() {
    return this.syncEngine.getMetrics()
  }

  /**
   * Check for alerts based on thresholds.
   */
  async getAlerts(): Promise<string[]> {
    const collector = getMetricsCollector()
    const metrics = await collector.collectMetrics()
    collector.recordSyncLatency(metrics.syncLatencyMs)
    return collector.shouldAlert()
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async initialize(): Promise<void> {
    if (this.options.autoStartSync !== false) {
      await this.startSync()
    }
  }

  async shutdown(): Promise<void> {
    await this.stopSync()
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────

let _api: ResourcePlaneApi | null = null

export function getResourcePlaneApi(options?: ResourcePlaneApiOptions): ResourcePlaneApi {
  if (!_api) {
    _api = new ResourcePlaneApi(options)
  }
  return _api
}

export function resetResourcePlaneApiForTest(): void {
  if (_api) {
    _api.shutdown().catch(() => {})
    _api = null
  }
  resetSyncEngine()
  resetMonitoringForTest()
}
