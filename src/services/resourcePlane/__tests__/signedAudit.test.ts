import { beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { runResourcePlaneMigrations } from '../migrations.js'
import { getPgPool } from '../../pg/pool.js'

const KEY = 'test-signed-audit-key-material'

let appendAuditEntry: typeof import('../signedAudit.js')['appendAuditEntry']
let signHash: typeof import('../signedAudit.js')['signHash']
let verifySignature: typeof import('../signedAudit.js')['verifySignature']

beforeAll(async () => {
  process.env.CCB_RESOURCE_PLANE_KEY = KEY
  await runResourcePlaneMigrations()
  // Import after env var is set
  const signedAudit = await import('../signedAudit.js')
  appendAuditEntry = signedAudit.appendAuditEntry
  signHash = signedAudit.signHash
  verifySignature = signedAudit.verifySignature
})

beforeEach(async () => {
  // Ensure the key is set before each test (in case it was deleted by a test)
  process.env.CCB_RESOURCE_PLANE_KEY = KEY
})

describe('Phase 6.0: Signed Audit Log', () => {
  test('appendAuditEntry stores a tamper-evident entry', async () => {
    const entry = await appendAuditEntry({
      actorNodeId: 'node-x',
      action: 'rotate',
      targetType: 'credential',
      targetId: 'acme:acc:userKey',
      metadata: { keyVersion: 3 },
    })

    expect(entry.id).toBeDefined()
    expect(entry.hash).toBeDefined()
    expect(entry.signature).toBeDefined()
    expect(entry.prevHash).toBeDefined()

    // Entry persisted
    const pool = getPgPool()
    const client = await pool.connect()
    try {
      const res = await client.query(
        `SELECT action, target_id FROM resource_plane.audit_events WHERE id = $1`,
        [entry.id],
      )
      expect(res.rows.length).toBe(1)
      expect(res.rows[0].action).toBe('rotate')
      expect(res.rows[0].target_id).toBe('acme:acc:userKey')
    } finally {
      client.release()
    }
  })

  test('each entry chains to the previous hash', async () => {
    const first = await appendAuditEntry({
      actorNodeId: 'n1',
      action: 'create',
      targetType: 'credential',
      targetId: 'a',
    })
    const second = await appendAuditEntry({
      actorNodeId: 'n2',
      action: 'delete',
      targetType: 'credential',
      targetId: 'b',
    })

    // Second entry's prevHash must equal first entry's hash
    expect(second.prevHash).toBe(first.hash)
  })

  test('signHash produces a deterministic HMAC and verifySignature accepts it', async () => {
    const hash = 'abc123'
    const sig = signHash(hash, KEY)
    expect(sig.length).toBeGreaterThan(0)
    expect(verifySignature({ hash, signature: sig, keyMaterial: KEY })).toBe(
      true,
    )
  })

  test('verifySignature rejects a wrong key', async () => {
    const hash = 'abc123'
    const sig = signHash(hash, KEY)
    expect(
      verifySignature({ hash, signature: sig, keyMaterial: 'wrong-key' }),
    ).toBe(false)
  })

  test('tampering with the hash invalidates the signature', async () => {
    const hash = 'original'
    const sig = signHash(hash, KEY)
    expect(
      verifySignature({ hash: 'tampered', signature: sig, keyMaterial: KEY }),
    ).toBe(false)
  })
})
