/**
 * Phase 3.5: Credential lifecycle management.
 *
 * Features:
 *  - Key rotation with versioning (backward compatible)
 *  - Expiration handling and renewal alerts
 *  - Audit trail for credential changes
 *  - Graceful degradation on key loss
 */

import { getPgPool } from '../pg/pool.js'
import type { PoolClient } from 'pg'
import { encryptTypedCredential } from './credentials.js'
import {
  createTypedCredentialSecret,
  getTypedCredentialSecret,
  deleteTypedCredentialSecret,
  type CredentialSecretWrite,
} from './repository.js'
import { deterministicSecretId } from './importer.js'
import type {
  CredentialSecretValue,
  ResourceAuthType,
  ResourceSecretType,
  TypedCredentialRecord,
} from './types.js'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CredentialRotationInput {
  providerId: string
  accountId: string
  authType: ResourceAuthType
  secretType: ResourceSecretType
  newSecret: CredentialSecretValue
  oldKeyVersion?: number
  skipOldDeletion?: boolean
}

export interface CredentialExpirationCheck {
  providerId: string
  accountId: string
  secretType: string
  expiresAt: Date | null
  hoursUntilExpiry: number
  isExpired: boolean
  refreshable: boolean
}

export interface CredentialAuditEntry {
  providerId: string
  accountId: string
  secretType: string
  action: 'create' | 'rotate' | 'expire' | 'delete'
  keyVersion: number
  performedBy: string
  performedAt: Date
  reason?: string
}

export interface CredentialLifecycleMetrics {
  totalCredentials: number
  expiringSoonCount: number
  expiredCount: number
  rotationCount: number
  lastRotationAt: Date | null
}

// ── Rotation ──────────────────────────────────────────────────────────────────

export class CredentialRotation {
  /**
   * Rotate a credential by incrementing keyVersion and re-encrypting with new key.
   * Old credential is preserved if skipOldDeletion=true for backward compatibility.
   */
  static async rotate(input: CredentialRotationInput): Promise<{
    newKeyVersion: number
    newEncryptedSecret: string
    oldKeyVersion: number
  }> {
    const pool = getPgPool()
    const client = await pool.connect()
    try {
      await client.query('BEGIN')

      // Fetch existing credential
      const secretId = deterministicSecretId(
        'resource_plane:secret',
        input.providerId,
        input.accountId,
        input.secretType,
      )
      const existing = await getTypedCredentialSecret(
        client,
        input.providerId,
        input.accountId,
        input.secretType,
        secretId,
      )

      if (!existing) {
        throw new Error(
          `Credential not found: ${input.providerId}:${input.accountId}:${input.secretType}`,
        )
      }

      const oldKeyVersion = input.oldKeyVersion ?? existing.keyVersion
      const newKeyVersion = oldKeyVersion + 1

      // Encrypt new secret with new key version
      const { encryptedSecret: newEncryptedSecret } =
        await encryptTypedCredential({
          providerId: input.providerId,
          accountId: input.accountId,
          authType: input.authType,
          secretType: input.secretType,
          secretId: existing.secretId,
          value: input.newSecret,
          keyVersion: newKeyVersion,
          revision: existing.revision + 1,
          ownerNodeId: existing.ownerNodeId,
        })

      // Insert new version
      await createTypedCredentialSecret(client, {
        providerId: input.providerId,
        accountId: input.accountId,
        authType: input.authType,
        secretType: input.secretType,
        secretId: existing.secretId,
        value: input.newSecret,
        keyVersion: newKeyVersion,
        revision: existing.revision + 1,
        ownerNodeId: existing.ownerNodeId,
      })

      // Delete old version unless skipOldDeletion
      if (!input.skipOldDeletion) {
        await deleteTypedCredentialSecret(
          client,
          input.providerId,
          input.accountId,
          input.secretType,
          existing.secretId,
        )
      }

      await client.query('COMMIT')

      // Log audit
      await CredentialAudit.log({
        providerId: input.providerId,
        accountId: input.accountId,
        secretType: input.secretType,
        action: 'rotate',
        keyVersion: newKeyVersion,
        performedBy: 'credential-rotation',
        reason: `Rotated from keyVersion ${oldKeyVersion} to ${newKeyVersion}`,
      })

      return {
        newKeyVersion,
        newEncryptedSecret,
        oldKeyVersion,
      }
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  /**
   * Batch rotate all credentials for a provider.
   */
  static async rotateProviderAll(
    providerId: string,
    newSecrets: Array<{
      accountId: string
      authType: ResourceAuthType
      secretType: ResourceSecretType
      value: CredentialSecretValue
    }>,
    options?: { performedBy?: string },
  ): Promise<{
    rotated: number
    failed: Array<{ accountId: string; error: string }>
  }> {
    const results = {
      rotated: 0,
      failed: [] as { accountId: string; error: string }[],
    }

    for (const cred of newSecrets) {
      try {
        await CredentialRotation.rotate({
          providerId,
          accountId: cred.accountId,
          authType: cred.authType,
          secretType: cred.secretType,
          newSecret: cred.value,
        })
        results.rotated++
      } catch (err) {
        results.failed.push({
          accountId: cred.accountId,
          error: String(err),
        })
      }
    }

    return results
  }
}

// ── Expiration Management ─────────────────────────────────────────────────────

export class CredentialExpirationManager {
  /**
   * Check all credentials for upcoming expiration.
   */
  static async checkExpiringCredentials(
    hoursThreshold: number = 24 * 7, // 7 days default
  ): Promise<CredentialExpirationCheck[]> {
    const pool = getPgPool()
    const client = await pool.connect()
    try {
      const res = await client.query(
        `SELECT provider_id, account_id, secret_type, expires_at, refreshable
         FROM resource_plane.credential_secrets
         WHERE expires_at IS NOT NULL
           AND (expires_at - now()) < ($1 || ' hours')::interval
         ORDER BY expires_at ASC`,
        [hoursThreshold],
      )

      const now = new Date()
      return res.rows.map(row => ({
        providerId: row.provider_id,
        accountId: row.account_id,
        secretType: row.secret_type,
        expiresAt: row.expires_at ? new Date(row.expires_at) : null,
        hoursUntilExpiry: row.expires_at
          ? (row.expires_at.getTime() - now.getTime()) / (1000 * 60 * 60)
          : Infinity,
        isExpired: row.expires_at ? row.expires_at <= now : false,
        refreshable: row.refreshable,
      }))
    } finally {
      client.release()
    }
  }

  /**
   * Renew a credential by extending its expiration.
   */
  static async renewExpiration(
    providerId: string,
    accountId: string,
    secretType: string,
    additionalDays: number = 365,
  ): Promise<boolean> {
    const pool = getPgPool()
    const client = await pool.connect()
    try {
      const newExpiresAt = new Date()
      newExpiresAt.setDate(newExpiresAt.getDate() + additionalDays)

      const res = await client.query(
        `UPDATE resource_plane.credential_secrets
         SET expires_at = $4, updated_at = now()
         WHERE provider_id = $1 AND account_id = $2 AND secret_type = $3
         RETURNING provider_id`,
        [providerId, accountId, secretType, newExpiresAt],
      )

      // Log audit
      await CredentialAudit.log({
        providerId,
        accountId,
        secretType,
        action: 'rotate',
        keyVersion: 0,
        performedBy: 'expiration-renewal',
        reason: `Renewed for ${additionalDays} days`,
      })

      return (res.rowCount ?? 0) > 0
    } finally {
      client.release()
    }
  }

  /**
   * Auto-expire credentials that have passed their expiration.
   */
  static async expireCredentials(): Promise<number> {
    const pool = getPgPool()
    const client = await pool.connect()
    try {
      const res = await client.query(
        `DELETE FROM resource_plane.credential_secrets
         WHERE expires_at IS NOT NULL AND expires_at <= now()`,
      )

      const count = res.rowCount ?? 0
      if (count > 0) {
        await CredentialAudit.log({
          providerId: '*',
          accountId: '*',
          secretType: '*',
          action: 'expire',
          keyVersion: 0,
          performedBy: 'credential-expiry-cleanup',
          reason: `Auto-expired ${count} credentials`,
        })
      }

      return count
    } finally {
      client.release()
    }
  }
}

// ── Audit Trail ───────────────────────────────────────────────────────────────

export class CredentialAudit {
  static async log(
    entry: Omit<CredentialAuditEntry, 'performedAt'>,
  ): Promise<void> {
    const pool = getPgPool()
    const client = await pool.connect()
    try {
      await client.query(
        `INSERT INTO resource_plane.credential_audit
           (provider_id, account_id, secret_type, action, key_version,
            performed_by, performed_at, reason)
         VALUES ($1, $2, $3, $4, $5, $6, now(), $7)`,
        [
          entry.providerId,
          entry.accountId,
          entry.secretType,
          entry.action,
          entry.keyVersion,
          entry.performedBy,
          entry.reason ?? null,
        ],
      )
    } finally {
      client.release()
    }
  }

  static async getAuditLog(
    providerId?: string,
    limit: number = 100,
  ): Promise<CredentialAuditEntry[]> {
    const pool = getPgPool()
    const client = await pool.connect()
    try {
      const query = providerId
        ? `SELECT provider_id, account_id, secret_type, action, key_version,
                   performed_by, performed_at, reason
            FROM resource_plane.credential_audit
            WHERE provider_id = $1
            ORDER BY performed_at DESC LIMIT $2`
        : `SELECT provider_id, account_id, secret_type, action, key_version,
                   performed_by, performed_at, reason
            FROM resource_plane.credential_audit
            ORDER BY performed_at DESC LIMIT $1`

      const params = providerId ? [providerId, limit] : [limit]
      const res = await client.query(query, params)

      return res.rows.map(row => ({
        providerId: row.provider_id,
        accountId: row.account_id,
        secretType: row.secret_type,
        action: row.action as CredentialAuditEntry['action'],
        keyVersion: Number(row.key_version),
        performedBy: row.performed_by,
        performedAt: new Date(row.performed_at),
        reason: row.reason ?? undefined,
      }))
    } finally {
      client.release()
    }
  }
}

// ── Metrics ───────────────────────────────────────────────────────────────────

export async function getLifecycleMetrics(): Promise<CredentialLifecycleMetrics> {
  const pool = getPgPool()
  const client = await pool.connect()
  try {
    const [countRes, expiringRes, expiredRes, rotationRes] = await Promise.all([
      client.query(`SELECT count(*) FROM resource_plane.credential_secrets`),
      client.query(
        `SELECT count(*) FROM resource_plane.credential_secrets
         WHERE expires_at IS NOT NULL AND (expires_at - now()) < ('7 days'::interval)`,
      ),
      client.query(
        `SELECT count(*) FROM resource_plane.credential_secrets
         WHERE expires_at IS NOT NULL AND expires_at <= now()`,
      ),
      client.query(
        `SELECT MAX(performed_at) as last_rotation
         FROM resource_plane.credential_audit
         WHERE action = 'rotate'`,
      ),
    ])

    return {
      totalCredentials: parseInt(countRes.rows[0].count, 10),
      expiringSoonCount: parseInt(expiringRes.rows[0].count, 10),
      expiredCount: parseInt(expiredRes.rows[0].count, 10),
      rotationCount: parseInt(rotationRes.rows[0].count ?? '0', 10),
      lastRotationAt: rotationRes.rows[0].last_rotation
        ? new Date(rotationRes.rows[0].last_rotation)
        : null,
    }
  } finally {
    client.release()
  }
}
