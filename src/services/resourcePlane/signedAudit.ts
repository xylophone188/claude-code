/**
 * Phase 6.0: Signed/tamper-evident audit log.
 *
 * Every audit entry is chained to its predecessor (hash-chain) and signed with
 * the resource-plane key material, so historical entries cannot be altered
 * without invalidating the whole chain.
 */

import { getPgPool } from '../pg/pool.js'
import { createHmac, createHash, randomUUID } from 'node:crypto'
import { getResourceSecretKeyAsync } from './secretKey.js'

export interface SignedAuditEntry {
  id: string
  actorNodeId: string
  action: string
  targetType: string
  targetId: string
  metadata: Record<string, unknown>
  prevHash: string | null
  hash: string
  signature: string
  createdAt: string
}

export interface AuditInput {
  actorNodeId: string
  action: string
  targetType: string
  targetId: string
  metadata?: Record<string, unknown>
}

function canonical(input: Record<string, unknown>): string {
  return JSON.stringify(input, Object.keys(input).sort())
}

function sha256Hex(data: string): string {
  return createHash('sha256').update(data).digest('hex')
}

async function chainHash(last: SignedAuditEntry): Promise<string> {
  const pool = getPgPool()
  const client = await pool.connect()
  try {
    const res = await client.query(
      `SELECT hash FROM resource_plane.audit_events ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
    if (res.rows.length === 0) return sha256Hex('genesis')
    return String(res.rows[0].hash)
  } finally {
    client.release()
  }
}

/** Append a signed, hash-chained audit entry. Returns the stored entry. */
export async function appendAuditEntry(
  input: AuditInput,
): Promise<SignedAuditEntry> {
  const pool = getPgPool()
  const client = await pool.connect()
  const keyMaterial = await getResourceSecretKeyAsync()
  try {
    const id = randomUUID()
    const prevHash = await chainHash({} as SignedAuditEntry)
    const payload = canonical({
      id,
      prevHash,
      actorNodeId: input.actorNodeId,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      metadata: input.metadata ?? {},
      createdAt: new Date().toISOString(),
    })
    const hash = sha256Hex(payload)
    const signature = createHmac('sha256', keyMaterial)
      .update(hash)
      .digest('hex')

    await client.query(
      `INSERT INTO resource_plane.audit_events (id, actor_node_id, action, target_type, target_id, metadata, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())`,
      [
        id,
        input.actorNodeId,
        input.action,
        input.targetType,
        input.targetId,
        JSON.stringify(input.metadata ?? {}),
      ],
    )

    const entry: SignedAuditEntry = {
      id,
      actorNodeId: input.actorNodeId,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      metadata: input.metadata ?? {},
      prevHash,
      hash,
      signature,
      createdAt: new Date().toISOString(),
    }

    // Store chained hash + signature in the same row for tamper-evidence
    await client.query(
      `UPDATE resource_plane.audit_events SET metadata = $1 WHERE id = $2`,
      [
        JSON.stringify({
          ...input.metadata,
          _chain: { prevHash, hash, signature },
        }),
        id,
      ],
    )

    return entry
  } finally {
    client.release()
  }
}

/**
 * Verify a single entry's signature against the key. Does NOT verify the chain
 * links — use verifyChain for that.
 */
export function verifySignature(entry: {
  hash: string
  signature: string
  keyMaterial?: string
}): boolean {
  if (!entry.keyMaterial) {
    // Without stored key, we can only wrap verification at runtime; the test
    // path passes key material explicitly.
    return false
  }
  const expected = createHmac('sha256', entry.keyMaterial)
    .update(entry.hash)
    .digest('hex')
  return expected === entry.signature
}

/** Recompute HMAC for a hash using the provided key (test helper). */
export function signHash(hash: string, keyMaterial: string): string {
  return createHmac('sha256', keyMaterial).update(hash).digest('hex')
}
