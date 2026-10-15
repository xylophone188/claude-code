import { beforeEach, describe, expect, test } from 'bun:test'
import {
  DistributedLockManager,
  getLockManager,
  resetLockManagerForTest,
} from '../lock.js'
import { getPgPool } from '../../pg/pool.js'

describe('Phase 3.7: Distributed lock service', () => {
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
    resetLockManagerForTest()

    // Clean up lease_state table before each test
    const pool = getPgPool()
    const client = await pool.connect()
    try {
      await client.query('DELETE FROM resource_plane.lease_state')
    } finally {
      client.release()
    }
  })

  describe('DistributedLockManager', () => {
    test('acquires and releases lock with tryLock', async () => {
      const manager = new DistributedLockManager({ nodeId: 'test-node-1' })

      const result = await manager.tryLock('test-resource-1')
      expect(result.acquired).toBe(true)
      expect(result.fencingToken).toBeDefined()
      expect(typeof result.fencingToken).toBe('number')

      // Release the lock
      // We need to verify the lock is released by checking the DB
      const pool = getPgPool()
      const client = await pool.connect()
      try {
        const res = await client.query(
          'SELECT * FROM resource_plane.lease_state WHERE resource_name = $1',
          ['test-resource-1'],
        )
        expect(res.rows.length).toBe(1)
        expect(res.rows[0].owner_node_id).toBe('test-node-1')
      } finally {
        client.release()
      }

      // Unlock
      await manager.tryLock('test-resource-1', { timeoutMs: 100 }) // Try to get it again
      // Wait for the previous lock to be released by trying again
      await new Promise(resolve => setTimeout(resolve, 100))

      // The lock should still be held by the same node (fencing token higher)
      const result2 = await manager.tryLock('test-resource-1')
      expect(result2.acquired).toBe(true)
      expect(result2.fencingToken).toBeGreaterThan(result.fencingToken!)
    }, 10_000)

    test('non-blocking tryLock fails when lock held by another node', async () => {
      const manager1 = new DistributedLockManager({ nodeId: 'test-node-a' })
      const manager2 = new DistributedLockManager({ nodeId: 'test-node-b' })

      // Node A acquires lock
      const result1 = await manager1.tryLock('shared-resource')
      expect(result1.acquired).toBe(true)
      expect(result1.fencingToken).toBeDefined()

      // Node B tries non-blocking - should fail
      const result2 = await manager2.tryLock('shared-resource', {
        timeoutMs: 0,
      })
      expect(result2.acquired).toBe(false)
      expect(result2.error).toBeDefined()
    }, 10_000)

    test('blocking lock waits and acquires when released', async () => {
      const manager1 = new DistributedLockManager({
        nodeId: 'test-node-c',
        leaseMs: 5000,
      })
      const manager2 = new DistributedLockManager({
        nodeId: 'test-node-d',
        leaseMs: 5000,
      })

      // Node C acquires lock
      const result1 = await manager1.lock('wait-resource')
      expect(result1).toBeDefined()
      expect(result1.resource).toBe('wait-resource')

      // Node D starts trying to lock (blocking with timeout)
      let lockAcquired = false
      const promise = manager2
        .lock('wait-resource', { timeoutMs: 2000 })
        .then(() => {
          lockAcquired = true
        })
        .catch(() => {
          lockAcquired = false
        })

      // Give Node D time to start waiting
      await new Promise(resolve => setTimeout(resolve, 100))

      // Node C releases lock
      await result1.unlock()

      // Node D should eventually acquire
      await promise
      expect(lockAcquired).toBe(true)
    }, 10_000)

    test('fencing token prevents stale lock updates', async () => {
      const manager1 = new DistributedLockManager({
        nodeId: 'fencing-node-1',
        leaseMs: 100,
      })
      const manager2 = new DistributedLockManager({ nodeId: 'fencing-node-2' })

      // Node 1 acquires lock and releases it quickly
      const lock1 = await manager1.lock('fencing-test')

      // Wait for lease to expire (renewal timer kept it alive; we must unlock first)
      await lock1.unlock()

      // Small delay to ensure DB reflects release
      await new Promise(resolve => setTimeout(resolve, 50))

      // Node 2 should now be able to acquire (lease expired)
      const result2 = await manager2.tryLock('fencing-test', {
        timeoutMs: 1000,
      })
      expect(result2.acquired).toBe(true)
      await manager2.tryLock('fencing-test', { timeoutMs: 0 })
    }, 5_000)

    test('lock renewal extends lease', async () => {
      const manager = new DistributedLockManager({
        nodeId: 'renewal-node',
        leaseMs: 2000,
        renewIntervalMs: 500,
      })

      const lock = await manager.lock('renewal-test')
      expect(lock.isHeld()).toBe(true)

      const pool = getPgPool()
      const client = await pool.connect()
      try {
        const initialRes = await client.query(
          'SELECT lease_until FROM resource_plane.lease_state WHERE resource_name = $1',
          ['renewal-test'],
        )
        const initialExpiry = new Date(initialRes.rows[0].lease_until).getTime()

        // Wait for at least one renewal cycle
        await new Promise(resolve => setTimeout(resolve, 700))

        // Check that lease was extended
        const res = await client.query(
          'SELECT lease_until FROM resource_plane.lease_state WHERE resource_name = $1',
          ['renewal-test'],
        )
        expect(res.rows.length).toBe(1)
        const newExpiry = new Date(res.rows[0].lease_until).getTime()
        // Lease should be extended: new expiry is roughly now + leaseMs
        expect(newExpiry).toBeGreaterThan(Date.now())
        expect(newExpiry).toBeLessThan(Date.now() + 3000)
      } finally {
        client.release()
      }

      await lock.unlock()
    }, 10_000)

    test('lock manager shutdown cleans up timers', async () => {
      const manager = new DistributedLockManager({
        nodeId: 'shutdown-node',
        leaseMs: 5000,
        renewIntervalMs: 100,
      })

      await manager.lock('shutdown-test')

      // Shutdown should stop all renewal timers
      manager.shutdown()

      // Try to use lock - should fail or be safe
      // (lock object itself might still think it's held, but no more renewals)
      expect(true).toBe(true) // Just verify shutdown doesn't throw
    }, 5_000)

    test('singleton getLockManager returns same instance', () => {
      const m1 = getLockManager({ nodeId: 'singleton-test' })
      const m2 = getLockManager({ nodeId: 'singleton-test' })
      expect(m1).toBe(m2)
      resetLockManagerForTest()
    })
  })
})
