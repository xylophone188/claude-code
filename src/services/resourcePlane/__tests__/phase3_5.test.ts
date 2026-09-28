import { beforeEach, describe, expect, test } from 'bun:test'
import { ResourcePlaneApi, resetResourcePlaneApiForTest } from '../api.js'
import { SyncEngine, resetSyncEngineForTest } from '../syncEngine.js'
import {
  CredentialRotation,
  CredentialExpirationManager,
  CredentialAudit,
  getLifecycleMetrics,
} from '../credentialLifecycle.js'
import {
  MetricsCollector,
  HealthChecker,
  resetMonitoringForTest,
} from '../monitoring.js'
import { runResourcePlaneMigrations } from '../migrations.js'
import { getPgPool } from '../../pg/pool.js'

describe('Phase 3.5: ResourcePlane extensions', () => {
  const ENV_KEY = 'CCB_RESOURCE_PLANE'
  const KEY_ENV = 'CCB_RESOURCE_PLANE_KEY'
  const ORIG_ENV = process.env[ENV_KEY]
  const ORIG_KEY = process.env[KEY_ENV]

  beforeEach(async () => {
    if (ORIG_ENV === undefined) {
      delete process.env[ENV_KEY]
    } else {
      process.env[ENV_KEY] = ORIG_ENV
    }
    if (ORIG_KEY === undefined) {
      delete process.env[KEY_ENV]
    } else {
      process.env[KEY_ENV] = ORIG_KEY
    }
    process.env[KEY_ENV] = 'test-resource-plane-key-material-for-testing'
    resetResourcePlaneApiForTest()
    resetSyncEngineForTest()
    resetMonitoringForTest()
    // Ensure migrations are applied
    await runResourcePlaneMigrations()
  })

  describe('Cross-service sync', () => {
    test('SyncEngine registers nodes and tracks heartbeats', async () => {
      const engine = new SyncEngine({
        nodeId: 'test-node-1',
        fencingEpoch: 1000,
      })
      await engine.start()

      const status = await engine.getNodeStatus('test-node-1')
      expect(status).not.toBeNull()
      expect(status!.nodeId).toBe('test-node-1')
      expect(status!.status).toBe('healthy')

      await engine.stop()
    }, 10_000)

    test('SyncEngine lists multiple nodes', async () => {
      const engine = new SyncEngine({
        nodeId: 'test-node-2',
        fencingEpoch: 2000,
        region: 'test-region',
      })
      await engine.start()

      // Register a second node
      await engine.registerNode({
        nodeId: 'test-node-3',
        lastRevision: 10,
        lastSyncedAt: new Date(),
        status: 'healthy',
        fencingEpoch: 3000,
        region: 'test-region',
        globalFencingEpoch: 3000,
      })

      const nodes = await engine.listNodes()
      expect(nodes.length).toBeGreaterThanOrEqual(2)

      await engine.stop()
    }, 10_000)
  })

  describe('Credential lifecycle', () => {
    test('CredentialExpirationManager checks expiring credentials', async () => {
      // This test verifies the query runs without error
      const pool = getPgPool()
      const client = await pool.connect()
      try {
        const result =
          await CredentialExpirationManager.checkExpiringCredentials(24 * 365)
        expect(Array.isArray(result)).toBe(true)
      } finally {
        client.release()
      }
    })

    test('CredentialAudit logs and retrieves entries', async () => {
      await CredentialAudit.log({
        providerId: 'test-provider',
        accountId: 'test-account',
        secretType: 'apiKey',
        action: 'rotate',
        keyVersion: 2,
        performedBy: 'test-user',
        performedAt: new Date(),
        reason: 'Test rotation',
      })

      const entries = await CredentialAudit.getAuditLog('test-provider', 10)
      expect(entries.length).toBeGreaterThan(0)
      expect(entries[0].providerId).toBe('test-provider')
      expect(entries[0].action).toBe('rotate')
    })

    test('CredentialRotation.rotate throws error on missing credential', async () => {
      await expect(
        CredentialRotation.rotate({
          providerId: 'nonexistent-provider',
          accountId: 'test-account',
          authType: 'apiKey',
          secretType: 'apiKey',
          newSecret: { type: 'apiKey', apiKey: 'test-key' },
        }),
      ).rejects.toThrow(/Credential not found/)
    })
  })

  describe('Monitoring', () => {
    test('MetricsCollector collects baseline metrics', async () => {
      const collector = new MetricsCollector()
      const metrics = await collector.collectMetrics()

      expect(typeof metrics.totalProviders).toBe('number')
      expect(typeof metrics.totalAccounts).toBe('number')
      expect(typeof metrics.syncLatencyMs).toBe('number')
      expect(metrics.timestamp instanceof Date).toBe(true)
    })

    test('HealthChecker reports overall status', async () => {
      const checker = new HealthChecker()
      const results = await checker.checkAll()
      const overall = checker.getOverallStatus(results)

      expect(['healthy', 'degraded', 'unhealthy']).toContain(overall)
      expect(results.size).toBeGreaterThan(0)
    })

    test('MetricsCollector calculates alert thresholds', async () => {
      const collector = new MetricsCollector()
      collector.recordSyncLatency(100)
      collector.recordSuccess()

      const alerts = collector.shouldAlert()
      expect(Array.isArray(alerts)).toBe(true)
    })
  })

  describe('Unified API', () => {
    test('ResourcePlaneApi initializes and provides health status', async () => {
      const api = new ResourcePlaneApi({ autoStartSync: false })
      const health = await api.getHealth()

      expect(health.overall).toBeDefined()
      expect(Array.isArray(health.checks)).toBe(true)
    })

    test('ResourcePlaneApi metrics endpoint returns data', async () => {
      const api = new ResourcePlaneApi({ autoStartSync: false })
      const metrics = await api.getMetrics()

      expect(typeof metrics.totalProviders).toBe('number')
      expect(typeof metrics.totalCredentials).toBe('number')
    })

    test('ResourcePlaneApi lifecycle methods work', async () => {
      const api = new ResourcePlaneApi({ autoStartSync: false })

      // Initialize without starting sync
      await api.initialize()

      // Get metrics
      const metrics = await api.getMetrics()
      expect(metrics).toBeDefined()

      // Shutdown
      await api.shutdown()
    })
  })

  describe('Integration: Full flow', () => {
    test('Sync engine + monitoring integration', async () => {
      const engine = new SyncEngine({
        nodeId: 'integration-node',
        fencingEpoch: 4000,
      })
      await engine.start()

      // Give heartbeat time to register
      await new Promise(resolve => setTimeout(resolve, 100))

      const nodes = await engine.listNodes()
      expect(nodes.some(n => n.nodeId === 'integration-node')).toBe(true)

      const metrics = await getLifecycleMetrics()
      expect(typeof metrics.totalCredentials).toBe('number')

      await engine.stop()
    }, 15_000)
  })
})
