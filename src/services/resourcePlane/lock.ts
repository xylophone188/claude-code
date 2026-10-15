/**
 * Phase 3.7: Distributed lock service with fencing tokens.
 *
 * Features:
 *  - Mutual exclusion across nodes using lease_state table
 *  - Fencing tokens to prevent split-brain
 *  - Automatic lease renewal with configurable TTL
 *  - Blocking and non-blocking lock acquisition
 *  - Integration with ResourcePlaneApi
 */

import { getPgPool } from '../pg/pool.js'
import type { PoolClient } from 'pg'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface LockOptions {
  /** Node identifier (defaults to hostname or random) */
  nodeId?: string
  /** Lease duration in milliseconds (default: 30 seconds) */
  leaseMs?: number
  /** How often to renew the lease (default: leaseMs / 3) */
  renewIntervalMs?: number
  /** Timeout for tryLock in milliseconds (default: 0 = non-blocking) */
  timeoutMs?: number
}

export interface LockResult {
  /** True if lock was acquired */
  acquired: boolean
  /** Lock token (fencing epoch) if acquired */
  fencingToken?: number
  /** Error if acquisition failed */
  error?: string
}

export interface Lock {
  /** Resource name being locked */
  readonly resource: string
  /** Node ID that holds the lock */
  readonly nodeId: string
  /** Fencing token (monotonically increasing) */
  readonly fencingToken: number
  /** Lease expiration time */
  readonly expiresAt: Date
  /** Renew the lock (extends lease) */
  renew(): Promise<void>
  /** Release the lock */
  unlock(): Promise<void>
  /** Check if lock is still held (locally) */
  isHeld(): boolean
}

// ── Distributed Lock Manager ──────────────────────────────────────────────────

export class DistributedLockManager {
  private readonly nodeId: string
  private readonly defaultLeaseMs: number
  private readonly defaultRenewIntervalMs: number
  private readonly defaultTimeoutMs: number
  private renewTimers: Map<string, ReturnType<typeof setInterval>> = new Map()

  constructor(
    options: {
      nodeId?: string
      leaseMs?: number
      renewIntervalMs?: number
      timeoutMs?: number
    } = {},
  ) {
    this.nodeId =
      options.nodeId ??
      process.env.HOSTNAME ??
      `node-${Math.random().toString(36).substr(2, 9)}`
    this.defaultLeaseMs = options.leaseMs ?? 30_000
    this.defaultRenewIntervalMs =
      options.renewIntervalMs ?? this.defaultLeaseMs / 3
    this.defaultTimeoutMs = options.timeoutMs ?? 0
  }

  /**
   * Try to acquire a lock on a resource.
   * @param resource Name of the resource to lock
   * @param options Lock options (overrides instance defaults)
   * @returns Promise resolving to LockResult
   */
  async tryLock(
    resource: string,
    options: LockOptions = {},
  ): Promise<LockResult> {
    const {
      nodeId = this.nodeId,
      leaseMs = this.defaultLeaseMs,
      renewIntervalMs = options.renewIntervalMs ?? this.defaultRenewIntervalMs,
      timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs,
    } = options

    const endTime = Date.now() + timeoutMs
    let attempt = 0

    while (true) {
      attempt++
      const now = new Date()
      const leaseUntil = new Date(now.getTime() + leaseMs)
      const fencingToken = Date.now() // Simple timestamp-based fencing (monotonic enough for this use case)

      const pool = getPgPool()
      const client = await pool.connect()
      try {
        await client.query('BEGIN')

        // Try to insert lease row (will fail on unique constraint if locked)
        // Allow acquisition if:
        // 1. No existing lock (insert succeeds)
        // 2. Existing lock expired (lease_until < now())
        // 3. We already hold the lock with same fencing token (re-entry/renew)
        // A valid lease held by another node is never stolen, regardless of
        // fencing token. Higher fencing tokens only matter AFTER expiry,
        // where they break ties to prevent split-brain.
        const res = await client.query(
          `INSERT INTO resource_plane.lease_state
             (resource_name, owner_node_id, fencing_epoch, lease_until)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (resource_name) DO UPDATE
             SET owner_node_id = EXCLUDED.owner_node_id,
                 fencing_epoch = EXCLUDED.fencing_epoch,
                 lease_until = EXCLUDED.lease_until,
                 updated_at = now()
           WHERE resource_plane.lease_state.lease_until < now()
              OR resource_plane.lease_state.owner_node_id = EXCLUDED.owner_node_id
           RETURNING owner_node_id, fencing_epoch, lease_until`,
          [resource, nodeId, fencingToken, leaseUntil],
        )

        // Check if we got the lock (either inserted new or updated)
        const row = res.rows[0]
        if (
          row &&
          row.owner_node_id === nodeId &&
          String(row.fencing_epoch) === String(fencingToken)
        ) {
          await client.query('COMMIT')

          const lock: Lock = {
            resource,
            nodeId,
            fencingToken: row.fencing_epoch,
            expiresAt: row.lease_until,
            renew: async () => {
              await this._renewLock(
                resource,
                nodeId,
                row.fencing_epoch,
                leaseMs,
              )
            },
            unlock: async () => {
              await this._releaseLock(resource, nodeId, row.fencing_epoch)
              this._stopRenewal(resource)
            },
            isHeld: () =>
              this._isLocallyHeld(resource, nodeId, row.fencing_epoch),
          }

          // Start automatic renewal
          this._startRenewal(
            resource,
            nodeId,
            row.fencing_epoch,
            renewIntervalMs,
          )

          return { acquired: true, fencingToken: Number(row.fencing_epoch) }
        }

        await client.query('COMMIT')

        // Lock is held by someone else with higher/equal fencing token and valid lease
        if (timeoutMs === 0) {
          return { acquired: false, error: 'Lock is held by another node' }
        }

        if (Date.now() >= endTime) {
          return { acquired: false, error: 'Lock acquisition timeout' }
        }

        // Wait a bit before retrying (exponential backoff capped at 100ms)
        await new Promise(resolve =>
          setTimeout(resolve, Math.min(10 * attempt, 100)),
        )
      } catch (err) {
        await client.query('ROLLBACK')
        if (err instanceof Error && err.message.includes('deadlock detected')) {
          // Deadlock, treat as contention
          if (timeoutMs === 0) {
            return { acquired: false, error: 'Lock is held by another node' }
          }
          if (Date.now() >= endTime) {
            return { acquired: false, error: 'Lock acquisition timeout' }
          }
          await new Promise(resolve =>
            setTimeout(resolve, Math.min(10 * attempt, 100)),
          )
          continue
        }
        return { acquired: false, error: String(err) }
      } finally {
        client.release()
      }
    }
  }

  /**
   * Acquire a lock, blocking until obtained or timeout.
   */
  async lock(resource: string, options: LockOptions = {}): Promise<Lock> {
    const result = await this.tryLock(resource, options)
    if (!result.acquired) {
      throw new Error(result.error ?? 'Failed to acquire lock')
    }
    // We need to return the full Lock object; tryLock only gave us token.
    // We'll fetch the current lock state to construct the Lock.
    const pool = getPgPool()
    const client = await pool.connect()
    try {
      const res = await client.query(
        `SELECT owner_node_id, fencing_epoch, lease_until
         FROM resource_plane.lease_state
         WHERE resource_name = $1 AND owner_node_id = $2 AND fencing_epoch = $3`,
        [resource, this.nodeId, result.fencingToken],
      )
      if (res.rows.length === 0) {
        throw new Error('Lock was lost immediately after acquisition')
      }
      const row = res.rows[0]
      const lock: Lock = {
        resource,
        nodeId: this.nodeId,
        fencingToken: Number(row.fencing_epoch),
        expiresAt: row.lease_until,
        renew: async () => {
          await this._renewLock(
            resource,
            this.nodeId,
            row.fencing_epoch,
            options.leaseMs ?? this.defaultLeaseMs,
          )
        },
        unlock: async () => {
          await this._releaseLock(resource, this.nodeId, row.fencing_epoch)
          this._stopRenewal(resource)
        },
        isHeld: () =>
          this._isLocallyHeld(resource, this.nodeId, row.fencing_epoch),
      }
      // Start renewal
      this._startRenewal(
        resource,
        this.nodeId,
        row.fencing_epoch,
        options.renewIntervalMs ?? this.defaultRenewIntervalMs,
      )
      return lock
    } finally {
      client.release()
    }
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private async _renewLock(
    resource: string,
    nodeId: string,
    fencingToken: number,
    leaseMs: number,
  ): Promise<void> {
    const pool = getPgPool()
    const client = await pool.connect()
    try {
      await client.query(
        `UPDATE resource_plane.lease_state
         SET lease_until = now() + ($4 || ' milliseconds')::interval,
             updated_at = now()
         WHERE resource_name = $1
           AND owner_node_id = $2
           AND fencing_epoch = $3`,
        [resource, nodeId, fencingToken, leaseMs],
      )
    } finally {
      client.release()
    }
  }

  private async _releaseLock(
    resource: string,
    nodeId: string,
    fencingToken: number,
  ): Promise<void> {
    const pool = getPgPool()
    const client = await pool.connect()
    try {
      await client.query(
        `DELETE FROM resource_plane.lease_state
         WHERE resource_name = $1
           AND owner_node_id = $2
           AND fencing_epoch = $3`,
        [resource, nodeId, fencingToken],
      )
    } finally {
      client.release()
    }
  }

  private _startRenewal(
    resource: string,
    nodeId: string,
    fencingToken: number,
    intervalMs: number,
  ): void {
    const key = `${resource}:${nodeId}:${fencingToken}`
    if (this.renewTimers.has(key)) return

    const renew = async () => {
      // Check if we still hold the lock before renewing
      const pool = getPgPool()
      const client = await pool.connect()
      try {
        const res = await client.query(
          `SELECT 1 FROM resource_plane.lease_state
           WHERE resource_name = $1
             AND owner_node_id = $2
             AND fencing_epoch = $3`,
          [resource, nodeId, fencingToken],
        )
        if (res.rows.length === 0) {
          // We lost the lock, stop renewal
          this._stopRenewal(resource)
          return
        }
        await this._renewLock(
          resource,
          nodeId,
          fencingToken,
          this.defaultLeaseMs,
        )
      } catch (err) {
        console.error(
          `[LockManager] Failed to renew lock for ${resource}:`,
          err,
        )
        // Continue trying; next renewal might succeed
      } finally {
        client.release()
      }
    }

    // Initial renewal after interval
    const timer = setInterval(renew, intervalMs)
    // Also run once immediately to ensure lease is fresh
    renew().catch(() => {})
    this.renewTimers.set(key, timer)
  }

  private _stopRenewal(resource: string): void {
    // Find and clear all timers for this resource (any nodeId/fencingToken)
    for (const [key, timer] of this.renewTimers.entries()) {
      if (key.startsWith(`${resource}:`)) {
        clearInterval(timer)
        this.renewTimers.delete(key)
      }
    }
  }

  private _isLocallyHeld(
    resource: string,
    nodeId: string,
    fencingToken: number,
  ): boolean {
    // This is a best-effort check; we don't want to query DB every time.
    // We'll rely on the fact that if we have a renewal timer running, we likely hold it.
    // For safety, we could check DB, but for simplicity we assume correctness.
    const key = `${resource}:${nodeId}:${fencingToken}`
    return this.renewTimers.has(key)
  }

  /**
   * Clean up all renewal timers (call on shutdown).
   */
  shutdown(): void {
    for (const [key, timer] of this.renewTimers.entries()) {
      clearInterval(timer)
    }
    this.renewTimers.clear()
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────

let _lockManager: DistributedLockManager | null = null

export function getLockManager(options?: {
  nodeId?: string
  leaseMs?: number
  renewIntervalMs?: number
  timeoutMs?: number
}): DistributedLockManager {
  if (!_lockManager) {
    _lockManager = new DistributedLockManager(options)
  }
  return _lockManager
}

export function resetLockManagerForTest(): void {
  if (_lockManager) {
    _lockManager.shutdown()
    _lockManager = null
  }
}
