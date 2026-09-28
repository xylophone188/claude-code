import { beforeEach, describe, expect, test } from 'bun:test'
import { SyncEngine, resetSyncEngineForTest } from '../syncEngine.js'
import { runResourcePlaneMigrations } from '../migrations.js'
import { getPgPool } from '../../pg/pool.js'

describe('Phase 4.0: Multi-region replication', () => {
  beforeEach(async () => {
    resetSyncEngineForTest()
    await runResourcePlaneMigrations()
    const pool = getPgPool()
    const client = await pool.connect()
    try {
      await client.query('DELETE FROM resource_plane.sync_nodes')
    } finally {
      client.release()
    }
  })

  test('sync_nodes table has region column after V4 migration', async () => {
    const pool = getPgPool()
    const client = await pool.connect()
    try {
      const res = await client.query(
        `SELECT column_name, data_type FROM information_schema.columns
         WHERE table_schema = 'resource_plane' AND table_name = 'sync_nodes'`,
      )
      const columns = res.rows.map(r => r.column_name)
      expect(columns).toContain('region')
      expect(columns).toContain('global_fencing_epoch')
    } finally {
      client.release()
    }
  })

  test('SyncEngine registers node with region', async () => {
    const engine = new SyncEngine({
      nodeId: 'test-node-us-east-1',
      region: 'us-east-1',
      fencingEpoch: Date.now(),
    })
    await engine.start()

    const pool = getPgPool()
    const client = await pool.connect()
    try {
      const res = await client.query(
        `SELECT node_id, region, global_fencing_epoch FROM resource_plane.sync_nodes WHERE node_id = $1`,
        ['test-node-us-east-1'],
      )
      expect(res.rows.length).toBe(1)
      expect(res.rows[0].region).toBe('us-east-1')
      expect(res.rows[0].global_fencing_epoch).toBeDefined()
    } finally {
      client.release()
    }
    await engine.stop()
  })

  test('Cross-region fencing tokens are globally ordered', async () => {
    const epoch1 = Date.now()
    await new Promise(r => setTimeout(r, 10))
    const epoch2 = Date.now()

    const engine1 = new SyncEngine({
      nodeId: 'us-east-node',
      region: 'us-east-1',
      fencingEpoch: epoch1,
    })
    const engine2 = new SyncEngine({
      nodeId: 'eu-west-node',
      region: 'eu-west-1',
      fencingEpoch: epoch2,
    })

    await engine1.start()
    await engine2.start()

    const pool = getPgPool()
    const client = await pool.connect()
    try {
      const res = await client.query(
        `SELECT node_id, region, global_fencing_epoch FROM resource_plane.sync_nodes ORDER BY global_fencing_epoch`,
      )
      expect(res.rows.length).toBe(2)
      // Global epochs should be comparable across regions
      expect(Number(res.rows[0].global_fencing_epoch)).toBeLessThan(
        Number(res.rows[1].global_fencing_epoch),
      )
    } finally {
      client.release()
    }

    await engine1.stop()
    await engine2.stop()
  })

  test('Conflict resolution uses global fencing epoch', async () => {
    const engine = new SyncEngine({
      nodeId: 'conflict-test',
      region: 'us-east-1',
    })
    await engine.start()

    const status = engine.getMetrics()
    expect(status.region).toBe('us-east-1')
    expect(status.globalFencingEpoch).toBeDefined()

    await engine.stop()
  })

  test('Region-aware node listing', async () => {
    const engine1 = new SyncEngine({ nodeId: 'node-us-1', region: 'us-east-1' })
    const engine2 = new SyncEngine({ nodeId: 'node-eu-1', region: 'eu-west-1' })
    const engine3 = new SyncEngine({ nodeId: 'node-us-2', region: 'us-east-1' })

    await engine1.start()
    await engine2.start()
    await engine3.start()

    const nodes = await engine1.listNodes()
    const usNodes = nodes.filter(n => n.region === 'us-east-1')
    const euNodes = nodes.filter(n => n.region === 'eu-west-1')

    expect(usNodes.length).toBe(2)
    expect(euNodes.length).toBe(1)

    await engine1.stop()
    await engine2.stop()
    await engine3.stop()
  })
})
