import { beforeEach, describe, expect, test } from 'bun:test'
import { SyncEngine, resetSyncEngineForTest } from '../syncEngine.js'
import {
  ActiveActiveReplication,
  GlobalVectorClockManager,
  resetActiveActiveForTest,
} from '../activeActive.js'
import { runResourcePlaneMigrations } from '../migrations.js'

describe('Phase 5.0: Active-Active Replication', () => {
  beforeEach(async () => {
    resetActiveActiveForTest()
    resetSyncEngineForTest()
    await runResourcePlaneMigrations()
    // Clear sync_nodes to ensure test isolation
    const { getPgPool } = await import('../../pg/pool.js')
    const pool = getPgPool()
    const client = await pool.connect()
    try {
      await client.query('DELETE FROM resource_plane.sync_nodes')
    } finally {
      client.release()
    }
  })

  test('ActiveActiveReplication registers two regions and reports metrics', async () => {
    const engine1 = new SyncEngine({
      nodeId: 'us-east-1-node',
      region: 'us-east-1',
      fencingEpoch: 100,
    })
    const replica = new ActiveActiveReplication(engine1, {
      localRegion: 'us-east-1',
      syncIntervalMs: 5000,
    })
    await replica.start()

    const engine2 = new SyncEngine({
      nodeId: 'eu-west-1-node',
      region: 'eu-west-1',
      fencingEpoch: 200,
    })
    await engine2.start()

    const metrics = await replica.getMetrics()
    expect(metrics.localRegion).toBe('us-east-1')
    expect(metrics.connectedRegions).toContain('eu-west-1')

    await engine2.stop()
    await replica.stop()
  }, 10_000)

  test('leader selection picks highest global fencing epoch', async () => {
    const engine = new SyncEngine({
      nodeId: 'sel-node',
      region: 'us-east-1',
      fencingEpoch: 5,
    })
    await engine.start()

    // Register two nodes in remote region with different epochs
    await engine.registerNode({
      nodeId: 'remote-a',
      lastRevision: 0,
      lastSyncedAt: new Date(),
      status: 'healthy',
      fencingEpoch: 3000,
      region: 'eu-west-1',
      globalFencingEpoch: 3000,
    })
    await engine.registerNode({
      nodeId: 'remote-b',
      lastRevision: 0,
      lastSyncedAt: new Date(),
      status: 'healthy',
      fencingEpoch: 9000,
      region: 'eu-west-1',
      globalFencingEpoch: 9000,
    })

    const nodes = await engine.listNodes()
    // Debug: log all nodes and their epochs
    console.log(
      'All nodes:',
      nodes.map(n => ({
        nodeId: n.nodeId,
        region: n.region,
        gfe: n.globalFencingEpoch,
      })),
    )
    const euWestNodes = nodes.filter(n => n.region === 'eu-west-1')
    console.log(
      'EU West nodes:',
      euWestNodes.map(n => ({ nodeId: n.nodeId, gfe: n.globalFencingEpoch })),
    )
    const replica = new ActiveActiveReplication(engine, {
      localRegion: 'us-east-1',
    })
    // @ts-expect-error private method under test
    const leader = replica._selectLeader(euWestNodes)
    expect(leader).not.toBeNull()
    expect(leader!.nodeId).toBe('remote-b')

    await engine.stop()
    await replica.stop()
  }, 10_000)
})

describe('GlobalVectorClock', () => {
  test('update keeps highest revision per node', () => {
    const clock = new GlobalVectorClockManager()
    clock.update('n1', 'us-east-1', 1)
    clock.update('n1', 'us-east-1', 5)
    clock.update('n1', 'us-east-1', 3) // stale, ignored
    const entries = clock.getClock()
    expect(entries).toHaveLength(1)
    expect(entries[0].revision).toBe(5)
  })

  test('merge unions revisions from another clock', () => {
    const a = new GlobalVectorClockManager()
    const b = new GlobalVectorClockManager()
    a.update('n1', 'us-east-1', 3)
    b.update('n1', 'us-east-1', 2)
    b.update('n2', 'eu-west-1', 7)

    a.merge(b)
    const byNode = new Map(a.getClock().map(e => [e.nodeId, e]))
    expect(byNode.get('n1')!.revision).toBe(3)
    expect(byNode.get('n2')!.revision).toBe(7)
  })

  test('isConcurrentWith detects causal ties', () => {
    const a = new GlobalVectorClockManager()
    const b = new GlobalVectorClockManager()
    // Same logical time in different regions = concurrent
    a.update('n1', 'us-east-1', 2)
    b.update('n2', 'eu-west-1', 2)
    expect(a.isConcurrentWith(b)).toBe(true)
  })
})
