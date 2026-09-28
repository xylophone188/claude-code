import type { PoolClient } from 'pg'
import {
  isResourceAuthType,
  isResourceSecretType,
  redactCredentialRecord,
  ResourcePlaneValidationError,
  type CredentialSecretValue,
  type ResourceProviderAccountMetadata,
  type TypedCredentialRecord,
} from './types.js'
import {
  decryptTypedCredential,
  encryptTypedCredential,
} from './credentials.js'

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function assertNonEmpty(value: string, label: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ResourcePlaneValidationError(
      `${label} must be a non-empty string`,
    )
  }
}

function toJson(value: unknown): string {
  return JSON.stringify(value ?? {})
}

function parseDate(value: unknown): Date {
  if (value instanceof Date) return value
  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) {
      throw new ResourcePlaneValidationError('credential timestamp is invalid')
    }
    return date
  }
  return null as unknown as Date
}

export async function createProviderAccountMetadata(
  tx: PoolClient,
  row: ResourceProviderAccountMetadata,
): Promise<ResourceProviderAccountMetadata> {
  assertNonEmpty(row.providerId, 'providerId')
  assertNonEmpty(row.accountId, 'accountId')
  if (!isResourceAuthType(row.authType)) {
    throw new ResourcePlaneValidationError(`unknown authType ${row.authType}`)
  }
  if (!Number.isInteger(row.revision) || row.revision < 1) {
    throw new ResourcePlaneValidationError(
      'revision must be a positive integer',
    )
  }
  const { rows } = await tx.query(
    `INSERT INTO resource_plane.provider_accounts
       (provider_id, account_id, name, auth_type, transport, base_url,
        owner_node_id, enabled, metadata, revision, updated_by_node_id, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())
     ON CONFLICT (provider_id, account_id) DO UPDATE SET
       name = EXCLUDED.name,
       auth_type = EXCLUDED.auth_type,
       transport = EXCLUDED.transport,
       base_url = EXCLUDED.base_url,
       owner_node_id = EXCLUDED.owner_node_id,
       enabled = EXCLUDED.enabled,
       metadata = EXCLUDED.metadata,
       revision = EXCLUDED.revision,
       updated_by_node_id = EXCLUDED.updated_by_node_id,
       updated_at = now()
     RETURNING provider_id, account_id, name, auth_type, transport, base_url,
       owner_node_id, enabled, metadata, revision, updated_by_node_id, updated_at`,
    [
      row.providerId,
      row.accountId,
      row.name ?? null,
      row.authType,
      row.transport ?? null,
      row.baseUrl ?? null,
      row.ownerNodeId ?? null,
      row.enabled,
      toJson(row.metadata),
      row.revision,
      row.updatedByNodeId ?? null,
    ],
  )
  const record = rows[0]
  if (!record)
    throw new ResourcePlaneValidationError('provider account insert failed')
  return {
    providerId: record.provider_id,
    accountId: record.account_id,
    name: record.name ?? undefined,
    authType: record.auth_type,
    transport: record.transport ?? undefined,
    baseUrl: record.base_url ?? undefined,
    ownerNodeId: record.owner_node_id ?? undefined,
    enabled: record.enabled,
    metadata: record.metadata,
    revision: Number(record.revision),
    updatedByNodeId: record.updated_by_node_id ?? undefined,
    updatedAt: parseDate(record.updated_at),
  }
}

export async function listProviderAccountMetadata(
  tx: PoolClient,
): Promise<ResourceProviderAccountMetadata[]> {
  const { rows } = await tx.query(
    `SELECT provider_id, account_id, name, auth_type, transport, base_url,
            owner_node_id, enabled, metadata, revision, updated_by_node_id, updated_at
     FROM resource_plane.provider_accounts
     ORDER BY provider_id, account_id`,
  )
  return rows.map((record: Record<string, unknown>) => ({
    providerId: String(record['provider_id']),
    accountId: String(record['account_id']),
    name: record['name'] == null ? undefined : String(record['name']),
    authType: record[
      'auth_type'
    ] as ResourceProviderAccountMetadata['authType'],
    transport:
      record['transport'] == null ? undefined : String(record['transport']),
    baseUrl:
      record['base_url'] == null ? undefined : String(record['base_url']),
    ownerNodeId:
      record['owner_node_id'] == null
        ? undefined
        : String(record['owner_node_id']),
    enabled: Boolean(record['enabled']),
    metadata: (record['metadata'] as Record<string, unknown> | null) ?? {},
    revision: Number(record['revision']),
    updatedByNodeId:
      record['updated_by_node_id'] == null
        ? undefined
        : String(record['updated_by_node_id']),
    updatedAt: parseDate(record['updated_at']),
  }))
}

export async function getProviderAccountMetadata(
  tx: PoolClient,
  providerId: string,
  accountId: string,
): Promise<ResourceProviderAccountMetadata | null> {
  const { rows } = await tx.query(
    `SELECT provider_id, account_id, name, auth_type, transport, base_url,
            owner_node_id, enabled, metadata, revision, updated_by_node_id, updated_at
     FROM resource_plane.provider_accounts
     WHERE provider_id = $1 AND account_id = $2`,
    [providerId, accountId],
  )
  if (rows.length === 0) return null
  const record = rows[0]
  return {
    providerId: record.provider_id,
    accountId: record.account_id,
    name: record.name ?? undefined,
    authType: record.auth_type,
    transport: record.transport ?? undefined,
    baseUrl: record.base_url ?? undefined,
    ownerNodeId: record.owner_node_id ?? undefined,
    enabled: record.enabled,
    metadata: record.metadata,
    revision: Number(record.revision),
    updatedByNodeId: record.updated_by_node_id ?? undefined,
    updatedAt: parseDate(record.updated_at),
  }
}

export interface CredentialSecretWrite {
  providerId: string
  accountId: string
  authType: TypedCredentialRecord['authType']
  secretType: TypedCredentialRecord['secretType']
  secretId: string
  value: CredentialSecretValue
  keyVersion?: number
  expiresAt?: Date | null
  refreshable?: boolean
  metadata?: Record<string, unknown>
  revision: number
  ownerNodeId?: string
}

export async function createTypedCredentialSecret(
  tx: PoolClient,
  row: CredentialSecretWrite,
): Promise<Omit<TypedCredentialRecord, 'encryptedSecret'>> {
  assertNonEmpty(row.providerId, 'providerId')
  assertNonEmpty(row.accountId, 'accountId')
  assertNonEmpty(row.secretId, 'secretId')
  if (!isResourceAuthType(row.authType)) {
    throw new ResourcePlaneValidationError(`unknown authType ${row.authType}`)
  }
  if (!isResourceSecretType(row.secretType)) {
    throw new ResourcePlaneValidationError(
      `unknown secretType ${row.secretType}`,
    )
  }
  if (!UUID_PATTERN.test(row.secretId)) {
    throw new ResourcePlaneValidationError('secretId must be a UUID')
  }
  if (!Number.isInteger(row.revision) || row.revision < 1) {
    throw new ResourcePlaneValidationError(
      'revision must be a positive integer',
    )
  }

  const keyVersion = row.keyVersion ?? 1
  const { encryptedSecret } = await encryptTypedCredential({
    providerId: row.providerId,
    accountId: row.accountId,
    authType: row.authType,
    secretType: row.secretType,
    secretId: row.secretId,
    value: row.value,
    revision: row.revision,
    keyVersion,
  })

  const { rows } = await tx.query(
    `INSERT INTO resource_plane.credential_secrets
       (provider_id, account_id, secret_type, auth_type, secret_id, key_version,
        encrypted_secret, expires_at, refreshable, metadata, revision, owner_node_id, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now())
     ON CONFLICT (provider_id, account_id, secret_type, secret_id) DO UPDATE SET
       auth_type = EXCLUDED.auth_type,
       key_version = EXCLUDED.key_version,
       encrypted_secret = EXCLUDED.encrypted_secret,
       expires_at = COALESCE(EXCLUDED.expires_at, resource_plane.credential_secrets.expires_at),
       refreshable = EXCLUDED.refreshable,
       metadata = EXCLUDED.metadata,
       revision = EXCLUDED.revision,
       owner_node_id = EXCLUDED.owner_node_id,
       updated_at = now()
     RETURNING provider_id, account_id, secret_type, auth_type, secret_id, key_version,
       expires_at, refreshable, metadata, revision, owner_node_id, updated_at`,
    [
      row.providerId,
      row.accountId,
      row.secretType,
      row.authType,
      row.secretId,
      keyVersion,
      encryptedSecret,
      row.expiresAt ?? null,
      row.refreshable ?? false,
      toJson(row.metadata),
      row.revision,
      row.ownerNodeId ?? null,
    ],
  )
  const record = rows[0]
  if (!record)
    throw new ResourcePlaneValidationError('credential secret insert failed')
  return {
    providerId: record.provider_id,
    accountId: record.account_id,
    secretType: record.secret_type,
    authType: record.auth_type,
    secretId: record.secret_id,
    keyVersion: record.key_version,
    expiresAt: record.expires_at ? parseDate(record.expires_at) : null,
    refreshable: record.refreshable,
    metadata: record.metadata,
    revision: Number(record.revision),
    ownerNodeId: record.owner_node_id ?? undefined,
    updatedAt: parseDate(record.updated_at),
  }
}

export async function getTypedCredentialSecret(
  tx: PoolClient,
  providerId: string,
  accountId: string,
  secretType: TypedCredentialRecord['secretType'],
  secretId: string,
  now: Date = new Date(),
): Promise<Omit<TypedCredentialRecord, 'encryptedSecret'> | null> {
  const { rows } = await tx.query(
    `SELECT provider_id, account_id, secret_type, auth_type, secret_id, key_version,
            expires_at, refreshable, metadata, revision, owner_node_id, updated_at
     FROM resource_plane.credential_secrets
     WHERE provider_id = $1 AND account_id = $2 AND secret_type = $3 AND secret_id = $4
       AND (expires_at IS NULL OR expires_at > $5)`,
    [providerId, accountId, secretType, secretId, now],
  )
  if (rows.length === 0) return null
  return redactCredentialRecord(rowToCredentialRecord(rows[0]))
}

export async function decryptCredentialSecret(
  tx: PoolClient,
  providerId: string,
  accountId: string,
  secretType: TypedCredentialRecord['secretType'],
  secretId: string,
  now: Date = new Date(),
): Promise<CredentialSecretValue | null> {
  const { rows } = await tx.query(
    `SELECT provider_id, account_id, secret_type, auth_type, secret_id, key_version,
            encrypted_secret, expires_at
     FROM resource_plane.credential_secrets
     WHERE provider_id = $1 AND account_id = $2 AND secret_type = $3 AND secret_id = $4`,
    [providerId, accountId, secretType, secretId],
  )
  if (rows.length === 0) return null
  const row = rows[0]
  const expiresAt = row.expires_at == null ? null : parseDate(row.expires_at)
  if (expiresAt && expiresAt <= now) return null
  return await decryptTypedCredential({
    providerId: row.provider_id,
    accountId: row.account_id,
    secretType: row.secret_type,
    authType: row.auth_type,
    keyVersion: row.key_version,
    encryptedSecret: row.encrypted_secret,
  })
}

function rowToCredentialRecord(
  row: Record<string, unknown>,
): TypedCredentialRecord {
  return {
    providerId: String(row['provider_id']),
    accountId: String(row['account_id']),
    secretType: row['secret_type'] as TypedCredentialRecord['secretType'],
    authType: row['auth_type'] as TypedCredentialRecord['authType'],
    secretId: String(row['secret_id']),
    keyVersion: Number(row['key_version']),
    encryptedSecret: String(row['encrypted_secret'] ?? ''),
    expiresAt: row['expires_at'] == null ? null : parseDate(row['expires_at']),
    refreshable: Boolean(row['refreshable']),
    metadata: (row['metadata'] as Record<string, unknown> | null) ?? {},
    revision: Number(row['revision']),
    ownerNodeId:
      row['owner_node_id'] == null ? undefined : String(row['owner_node_id']),
    updatedAt: parseDate(row['updated_at']),
  }
}

export interface ModelCapabilityWrite {
  providerId: string
  modelId: string
  capabilities: Record<string, unknown>
  limits: Record<string, unknown>
  revision: number
}

export async function upsertModelCapability(
  tx: PoolClient,
  row: ModelCapabilityWrite,
): Promise<void> {
  assertNonEmpty(row.providerId, 'providerId')
  assertNonEmpty(row.modelId, 'modelId')
  await tx.query(
    `INSERT INTO resource_plane.model_capabilities
       (provider_id, model_id, capabilities, limits, revision, updated_at)
     VALUES ($1, $2, $3, $4, $5, now())
     ON CONFLICT (provider_id, model_id) DO UPDATE SET
       capabilities = EXCLUDED.capabilities,
       limits = EXCLUDED.limits,
       revision = EXCLUDED.revision,
       updated_at = now()`,
    [
      row.providerId,
      row.modelId,
      toJson(row.capabilities),
      toJson(row.limits),
      row.revision,
    ],
  )
}

export async function listModelCapabilities(
  tx: PoolClient,
  providerId?: string,
): Promise<
  Array<{
    providerId: string
    modelId: string
    capabilities: Record<string, unknown>
    limits: Record<string, unknown>
    revision: number
  }>
> {
  const { rows } = providerId
    ? await tx.query(
        `SELECT provider_id, model_id, capabilities, limits, revision
         FROM resource_plane.model_capabilities
         WHERE provider_id = $1
         ORDER BY provider_id, model_id`,
        [providerId],
      )
    : await tx.query(
        `SELECT provider_id, model_id, capabilities, limits, revision
         FROM resource_plane.model_capabilities
         ORDER BY provider_id, model_id`,
      )
  return rows.map((record: Record<string, unknown>) => ({
    providerId: String(record['provider_id']),
    modelId: String(record['model_id']),
    capabilities:
      (record['capabilities'] as Record<string, unknown> | null) ?? {},
    limits: (record['limits'] as Record<string, unknown> | null) ?? {},
    revision: Number(record['revision']),
  }))
}

export interface ProviderHealthWrite {
  providerId: string
  accountId?: string
  modelId?: string
  health: Record<string, unknown>
}

export async function upsertProviderHealth(
  tx: PoolClient,
  row: ProviderHealthWrite,
): Promise<void> {
  assertNonEmpty(row.providerId, 'providerId')
  await tx.query(
    `INSERT INTO resource_plane.provider_health
       (provider_id, account_id, model_id, health, updated_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (provider_id, account_id, model_id) DO UPDATE SET
       health = EXCLUDED.health,
       updated_at = now()`,
    [
      row.providerId,
      row.accountId ?? '',
      row.modelId ?? '',
      toJson(row.health),
    ],
  )
}

export async function listProviderHealth(tx: PoolClient): Promise<
  Array<{
    providerId: string
    accountId: string
    modelId: string
    health: Record<string, unknown>
  }>
> {
  const { rows } = await tx.query(
    `SELECT provider_id, account_id, model_id, health
     FROM resource_plane.provider_health
     ORDER BY provider_id, account_id, model_id`,
  )
  return rows.map((record: Record<string, unknown>) => ({
    providerId: String(record['provider_id']),
    accountId: String(record['account_id']),
    modelId: String(record['model_id']),
    health: (record['health'] as Record<string, unknown> | null) ?? {},
  }))
}

// ── Delete primitives for sync ────────────────────────────────────────────────

export async function deleteProviderAccountMetadata(
  tx: PoolClient,
  providerId: string,
  accountId: string,
): Promise<boolean> {
  assertNonEmpty(providerId, 'providerId')
  assertNonEmpty(accountId, 'accountId')
  const { rowCount } = await tx.query(
    `DELETE FROM resource_plane.provider_accounts
     WHERE provider_id = $1 AND account_id = $2`,
    [providerId, accountId],
  )
  return (rowCount ?? 0) > 0
}

export async function deleteTypedCredentialSecret(
  tx: PoolClient,
  providerId: string,
  accountId: string,
  secretType: TypedCredentialRecord['secretType'],
  secretId: string,
): Promise<boolean> {
  assertNonEmpty(providerId, 'providerId')
  assertNonEmpty(accountId, 'accountId')
  assertNonEmpty(secretId, 'secretId')
  const { rowCount } = await tx.query(
    `DELETE FROM resource_plane.credential_secrets
     WHERE provider_id = $1 AND account_id = $2 AND secret_type = $3 AND secret_id = $4`,
    [providerId, accountId, secretType, secretId],
  )
  return (rowCount ?? 0) > 0
}

export async function deleteModelCapability(
  tx: PoolClient,
  providerId: string,
  modelId: string,
): Promise<boolean> {
  assertNonEmpty(providerId, 'providerId')
  assertNonEmpty(modelId, 'modelId')
  const { rowCount } = await tx.query(
    `DELETE FROM resource_plane.model_capabilities
     WHERE provider_id = $1 AND model_id = $2`,
    [providerId, modelId],
  )
  return (rowCount ?? 0) > 0
}

export interface SyncToResourcePlaneResult {
  accountsUpserted: number
  accountsDeleted: number
  credentialsUpserted: number
  credentialsDeleted: number
  capabilitiesUpserted: number
  capabilitiesDeleted: number
}
