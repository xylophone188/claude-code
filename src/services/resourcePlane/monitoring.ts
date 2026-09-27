/**
 * Phase 3.5: Monitoring and metrics for ResourcePlane.
 *
 * Features:
 *  - Sync latency tracking
 *  - Failure rate monitoring
 *  - Health check aggregation
 *  - Alert threshold configuration
 */

import { getPgPool } from '../pg/pool.js'
import type { PoolClient } from 'pg'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ResourcePlaneMetrics {
  timestamp: Date
  totalProviders: number
  totalAccounts: number
  totalCredentials: number
  totalCapabilities: number
  syncLatencyMs: number
  lastSyncRevision: number
  credentialExpiringSoon: number
  credentialExpired: number
  nodeCount: number
  syncErrors: number
}

export interface HealthCheckResult {
  component: string
  status: 'healthy' | 'unhealthy' | 'degraded'
  details?: string
  latencyMs?: number
}

export interface AlertThreshold {
  syncLatencyThresholdMs: number
  failureRateThreshold: number
  credentialExpiringSoonThreshold: number
  healthCheckFailureThreshold: number
}

// ── Default thresholds ────────────────────────────────────────────────────────

export const DEFAULT_THRESHOLDS: AlertThreshold = {
  syncLatencyThresholdMs: 5000,
  failureRateThreshold: 0.05, // 5%
  credentialExpiringSoonThreshold: 100,
  healthCheckFailureThreshold: 3,
}

// ── Metrics Collector ─────────────────────────────────────────────────────────

export class MetricsCollector {
  private readonly thresholds: AlertThreshold
  private _syncLatencies: number[] = []
  private _failureCount: number = 0
  private _totalOperations: number = 0

  constructor(thresholds?: Partial<AlertThreshold>) {
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...thresholds }
  }

  async collectMetrics(): Promise<ResourcePlaneMetrics> {
    const startMs = Date.now()
    const pool = getPgPool()
    const client = await pool.connect()
    try {
      const [
        providersRes,
        accountsRes,
        credentialsRes,
        capabilitiesRes,
        syncNodesRes,
        expiringRes,
        expiredRes,
        lastRevisionRes,
      ] = await Promise.all([
        client.query(`SELECT count(DISTINCT provider_id) as cnt FROM resource_plane.provider_accounts`),
        client.query(`SELECT count(*) as cnt FROM resource_plane.provider_accounts`),
        client.query(`SELECT count(*) as cnt FROM resource_plane.credential_secrets`),
        client.query(`SELECT count(*) as cnt FROM resource_plane.model_capabilities`),
        client.query(`SELECT count(*) as cnt FROM resource_plane.sync_nodes`),
        client.query(
          `SELECT count(*) as cnt FROM resource_plane.credential_secrets
           WHERE expires_at IS NOT NULL AND (expires_at - now()) < ('7 days'::interval)`,
        ),
        client.query(
          `SELECT count(*) as cnt FROM resource_plane.credential_secrets
           WHERE expires_at IS NOT NULL AND expires_at <= now()`,
        ),
        client.query(
          `SELECT MAX(revision) as max_revision FROM resource_plane.provider_accounts`,
        ),
      ])

      const syncLatency = this._calculateAvgSyncLatency()
      const failureRate = this._calculateFailureRate()

      return {
        timestamp: new Date(),
        totalProviders: parseInt(providersRes.rows[0].cnt),
        totalAccounts: parseInt(accountsRes.rows[0].cnt),
        totalCredentials: parseInt(credentialsRes.rows[0].cnt),
        totalCapabilities: parseInt(capabilitiesRes.rows[0].cnt),
        syncLatencyMs: syncLatency,
        lastSyncRevision: parseInt(lastRevisionRes.rows[0].max_revision ?? '0'),
        credentialExpiringSoon: parseInt(expiringRes.rows[0].cnt),
        credentialExpired: parseInt(expiredRes.rows[0].cnt),
        nodeCount: parseInt(syncNodesRes.rows[0].cnt),
        syncErrors: this._failureCount,
      }
    } finally {
      client.release()
    }
  }

  recordSyncLatency(ms: number): void {
    this._syncLatencies.push(ms)
    // Keep only last 100 measurements
    if (this._syncLatencies.length > 100) {
      this._syncLatencies.shift()
    }
  }

  recordFailure(): void {
    this._failureCount++
    this._totalOperations++
  }

  recordSuccess(): void {
    this._totalOperations++
  }

  private _calculateAvgSyncLatency(): number {
    if (this._syncLatencies.length === 0) return 0
    const sum = this._syncLatencies.reduce((a, b) => a + b, 0)
    return Math.round(sum / this._syncLatencies.length)
  }

  private _calculateFailureRate(): number {
    if (this._totalOperations === 0) return 0
    return this._failureCount / this._totalOperations
  }

  shouldAlert(): string[] {
    const alerts: string[] = []

    if (this._calculateAvgSyncLatency() > this.thresholds.syncLatencyThresholdMs) {
      alerts.push(
        `Sync latency ${this._calculateAvgSyncLatency()}ms exceeds threshold ${this.thresholds.syncLatencyThresholdMs}ms`,
      )
    }

    if (this._calculateFailureRate() > this.thresholds.failureRateThreshold) {
      alerts.push(
        `Failure rate ${this._calculateFailureRate().toFixed(2)}% exceeds threshold ${(this.thresholds.failureRateThreshold * 100).toFixed(0)}%`,
      )
    }

    return alerts
  }
}

// ── Health Checker ────────────────────────────────────────────────────────────

export class HealthChecker {
  constructor(private readonly thresholds: AlertThreshold = DEFAULT_THRESHOLDS) {}

  async checkAll(): Promise<Map<string, HealthCheckResult>> {
    const results = new Map<string, HealthCheckResult>()

    // Check PG connectivity
    const pgHealth = await this._checkPgHealth()
    results.set('postgresql', pgHealth)

    // Check credential encryption
    const encryptionHealth = await this._checkEncryptionHealth()
    results.set('encryption', encryptionHealth)

    // Check sync nodes
    const syncHealth = await this._checkSyncHealth()
    results.set('sync', syncHealth)

    // Check credential expiration
    const expirationHealth = await this._checkExpirationHealth()
    results.set('expiration', expirationHealth)

    return results
  }

  private async _checkPgHealth(): Promise<HealthCheckResult> {
    const startMs = Date.now()
    try {
      const pool = getPgPool()
      const client = await pool.connect()
      try {
        await client.query('SELECT 1')
        return {
          component: 'postgresql',
          status: 'healthy',
          latencyMs: Date.now() - startMs,
        }
      } finally {
        client.release()
      }
    } catch (err) {
      return {
        component: 'postgresql',
        status: 'unhealthy',
        details: String(err),
        latencyMs: Date.now() - startMs,
      }
    }
  }

  private async _checkEncryptionHealth(): Promise<HealthCheckResult> {
    try {
      const { hasResourceSecretKeyAsync } = await import('./secretKey.js')
      const hasKey = await hasResourceSecretKeyAsync()
      return {
        component: 'encryption',
        status: hasKey ? 'healthy' : 'unhealthy',
        details: hasKey ? 'Encryption key available' : 'No encryption key found',
      }
    } catch (err) {
      return {
        component: 'encryption',
        status: 'unhealthy',
        details: String(err),
      }
    }
  }

  private async _checkSyncHealth(): Promise<HealthCheckResult> {
    const pool = getPgPool()
    const client = await pool.connect()
    try {
      const res = await client.query(
        `SELECT count(*) as cnt FROM resource_plane.sync_nodes`,
      )
      const nodeCount = parseInt(res.rows[0].cnt)
      return {
        component: 'sync',
        status: nodeCount > 0 ? 'healthy' : 'degraded',
        details: `Active nodes: ${nodeCount}`,
      }
    } finally {
      client.release()
    }
  }

  private async _checkExpirationHealth(): Promise<HealthCheckResult> {
    const pool = getPgPool()
    const client = await pool.connect()
    try {
      const res = await client.query(
        `SELECT count(*) as cnt FROM resource_plane.credential_secrets
         WHERE expires_at IS NOT NULL AND (expires_at - now()) < ('7 days'::interval)`,
      )
      const expiringSoon = parseInt(res.rows[0].cnt)
      return {
        component: 'expiration',
        status: expiringSoon <= this.thresholds.credentialExpiringSoonThreshold
          ? 'healthy'
          : 'degraded',
        details: `${expiringSoon} credentials expiring within 7 days`,
      }
    } finally {
      client.release()
    }
  }

  getOverallStatus(results: Map<string, HealthCheckResult>): 'healthy' | 'degraded' | 'unhealthy' {
    const statuses = [...results.values()]
    if (statuses.some(r => r.status === 'unhealthy')) return 'unhealthy'
    if (statuses.some(r => r.status === 'degraded')) return 'degraded'
    return 'healthy'
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────

let _metricsCollector: MetricsCollector | null = null
let _healthChecker: HealthChecker | null = null

export function getMetricsCollector(): MetricsCollector {
  if (!_metricsCollector) {
    _metricsCollector = new MetricsCollector()
  }
  return _metricsCollector
}

export function getHealthChecker(): HealthChecker {
  if (!_healthChecker) {
    _healthChecker = new HealthChecker()
  }
  return _healthChecker
}

export function resetMonitoringForTest(): void {
  _metricsCollector = null
  _healthChecker = null
}
