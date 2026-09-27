import { getPgPool } from '../pg/pool.js'
import type { PoolClient } from 'pg'
import {
  createProviderAccountMetadata,
  createTypedCredentialSecret,
  upsertModelCapability,
  deleteProviderAccountMetadata,
  deleteTypedCredentialSecret,
  deleteModelCapability,
  type SyncToResourcePlaneResult,
} from './repository.js'
import {
  validateResourceAuthSecretPair,
  type ResourceAuthType,
  type ResourceProviderAccountMetadata,
  type ResourceSecretType,
} from './types.js'
import { ProviderConfig } from '../providerRegistry/types.js'
import { deterministicSecretId } from './importer.js'

export interface WriteAdapterOptions {
  ownerNodeId?: string
  revision?: number
}

export interface CredentialSecretWrite {
  providerId: string
  accountId: string
  authType: ResourceAuthType
  secretType: ResourceSecretType
  secretId: string
  value: CredentialSecretValue
  keyVersion?: number
  expiresAt?: Date | null
  refreshable?: boolean
  metadata?: Record<string, unknown>
  revision: number
  ownerNodeId?: string
}

export interface ModelCapabilityWrite {
  providerId: string
  modelId: string
  capabilities: Record<string, unknown>
  limits: Record<string, unknown>
  revision: number
}

export type CredentialSecretValue =
  | { type: 'apiKey'; apiKey: string }
  | { type: 'oauth'; accessToken: string; refreshToken?: string; idToken?: string; clientSecret?: string }
  | { type: 'custom'; secrets: Record<string, string> }

export interface ResourcePlaneImportBundle {
  accounts: ResourceProviderAccountMetadata[]
  credentials: CredentialSecretWrite[]
  capabilities: ModelCapabilityWrite[]
}

/**
 * Type for raw account data with flexible token support.
 */
export interface RawAccount {
  id?: string
  name?: string
  apiKey?: string
  model?: string
  tokens?: Record<string, string>
  enabled?: boolean
  metadata?: Record<string, unknown>
  [key: string]: unknown
}

/**
 * Transform ProviderConfig array to ResourcePlane import bundle.
 */
export function transformProviders(
  providers: ProviderConfig[],
  options?: { ownerNodeId?: string },
): ResourcePlaneImportBundle {
  const accounts: ResourceProviderAccountMetadata[] = []
  const credentials: CredentialSecretWrite[] = []
  const capabilities: ModelCapabilityWrite[] = []
  const seenAccountKeys = new Set<string>()
  const seenSecretKeys = new Set<string>()
  const seenCapabilityKeys = new Set<string>()

  for (const entry of providers) {
    const providerId = String(entry.id).trim()
    const transport = entry.kind || 'openai-compat'
    const baseUrl = entry.baseUrl

    const modelSet = new Set<string>()
    if (entry.defaultModel) modelSet.add(entry.defaultModel)
    if (Array.isArray(entry.models)) {
      for (const m of entry.models) {
        if (typeof m === 'string' && m.trim()) modelSet.add(m.trim())
      }
    }

    // Normalize accounts to raw format with full flexibility
    const rawAccounts: RawAccount[] = Array.isArray(entry.accounts) && entry.accounts.length > 0
      ? entry.accounts.map(acc => ({ ...acc }))
      : [{ id: 'default', apiKey: entry.apiKey }]

    for (const acc of rawAccounts) {
      const accountId = String(acc.id || 'default').trim()
      const accountKey = `${providerId}:${accountId}`
      if (acc.model) modelSet.add(acc.model)

      // Check for OAuth tokens
      const tokens = acc.tokens as Record<string, string> | undefined
      const hasOAuth = Boolean(
        tokens?.access_token ||
          tokens?.refresh_token ||
          entry.kind?.toLowerCase().includes('oauth'),
      )
      const authType: ResourceAuthType = hasOAuth ? 'oauth' : 'apiKey'

      if (!seenAccountKeys.has(accountKey)) {
        seenAccountKeys.add(accountKey)
        const metadata: Record<string, unknown> = {
          ...(entry.reasoningEffortMax !== undefined ? { reasoningEffortMax: entry.reasoningEffortMax } : {}),
          ...(entry.compatRule ? { compatRule: entry.compatRule } : {}),
          ...(entry.headers ? { headers: entry.headers } : {}),
          ...(entry.apiKeyEnv ? { apiKeyEnv: entry.apiKeyEnv } : {}),
          ...(entry.defaultModel ? { defaultModel: entry.defaultModel } : {}),
          ...(acc.metadata || {}),
        }

        accounts.push({
          providerId,
          accountId,
          name: acc.name || (accountId === 'default' ? providerId : `${providerId}-${accountId}`),
          authType,
          transport,
          baseUrl,
          enabled: acc.enabled ?? true,
          ownerNodeId: options?.ownerNodeId,
          metadata,
          revision: 1,
          updatedAt: new Date(),
        })
      }

      if (authType === 'apiKey' && acc.apiKey && typeof acc.apiKey === 'string') {
        const secretType: ResourceSecretType = 'apiKey'
        validateResourceAuthSecretPair(authType, secretType)
        const secretId = deterministicSecretId('resource_plane:secret', providerId, accountId, secretType)
        const secretKey = `${providerId}:${accountId}:${secretType}:${secretId}`
        if (!seenSecretKeys.has(secretKey)) {
          seenSecretKeys.add(secretKey)
          credentials.push({
            providerId,
            accountId,
            authType,
            secretType,
            secretId,
            value: { type: 'apiKey', apiKey: acc.apiKey },
            keyVersion: 1,
            revision: 1,
            ownerNodeId: options?.ownerNodeId,
          })
        }
      }

      if (authType === 'oauth' && tokens) {
        const secretTypes: ResourceSecretType[] = ['accessToken', 'refreshToken', 'idToken', 'clientSecret']
        for (const secretType of secretTypes) {
          const value = tokens[`${secretType.replace(/Token$/, '_token')}` as keyof typeof tokens]
          if (value && typeof value === 'string') {
            validateResourceAuthSecretPair(authType, secretType)
            const secretId = deterministicSecretId('resource_plane:secret', providerId, accountId, secretType)
            const secretKey = `${providerId}:${accountId}:${secretType}:${secretId}`
            if (!seenSecretKeys.has(secretKey)) {
              seenSecretKeys.add(secretKey)
              credentials.push({
                providerId,
                accountId,
                authType,
                secretType,
                secretId,
                value: {
                  type: 'oauth',
                  accessToken: tokens.access_token ?? '',
                  refreshToken: tokens.refresh_token,
                  idToken: tokens.id_token,
                  clientSecret: tokens.client_secret,
                },
                keyVersion: 1,
                revision: 1,
                ownerNodeId: options?.ownerNodeId,
              })
            }
          }
        }
      }
    }

    for (const modelId of modelSet) {
      const capabilityKey = `${providerId}:${modelId}`
      if (!seenCapabilityKeys.has(capabilityKey)) {
        seenCapabilityKeys.add(capabilityKey)
        capabilities.push({
          providerId,
          modelId,
          capabilities: {},
          limits: {},
          revision: 1,
        })
      }
    }
  }

  return { accounts, credentials, capabilities }
}

/**
 * Sync ProviderConfig array to resourcePlane database atomically.
 * Full reconciliation: PG ends up exactly matching the input bundle.
 * Providers NOT in the bundle are removed from PG (accounts, credentials, capabilities).
 */
export async function syncToResourcePlane(
  providers: ProviderConfig[],
  options: WriteAdapterOptions = {},
): Promise<SyncToResourcePlaneResult> {
  const pool = getPgPool()
  const ownerNodeId = options.ownerNodeId ?? 'unknown'
  const revision = options.revision ?? 1

  const { accounts: newAccounts, credentials: newCredentials, capabilities: newCapabilities } =
    transformProviders(providers, { ownerNodeId, revision })

  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    const bundleProviderIds = new Set(newAccounts.map(a => a.providerId))

    // 1. Delete providers NOT in bundle (full reconciliation)
    // Order: capabilities -> credentials -> accounts (FK constraints)
    let capabilityDeletions = 0
    if (bundleProviderIds.size > 0) {
      const res = await client.query(
        `DELETE FROM resource_plane.model_capabilities WHERE provider_id NOT IN (${Array.from(bundleProviderIds).map((_, i) => `$${i + 1}`).join(',')})`,
        Array.from(bundleProviderIds),
      )
      capabilityDeletions = res.rowCount ?? 0
    } else {
      const res = await client.query(`DELETE FROM resource_plane.model_capabilities`)
      capabilityDeletions = res.rowCount ?? 0
    }

    let credentialDeletions = 0
    if (bundleProviderIds.size > 0) {
      const res = await client.query(
        `DELETE FROM resource_plane.credential_secrets WHERE provider_id NOT IN (${Array.from(bundleProviderIds).map((_, i) => `$${i + 1}`).join(',')})`,
        Array.from(bundleProviderIds),
      )
      credentialDeletions = res.rowCount ?? 0
    } else {
      const res = await client.query(`DELETE FROM resource_plane.credential_secrets`)
      credentialDeletions = res.rowCount ?? 0
    }

    let accountDeletions = 0
    if (bundleProviderIds.size > 0) {
      const res = await client.query(
        `DELETE FROM resource_plane.provider_accounts WHERE provider_id NOT IN (${Array.from(bundleProviderIds).map((_, i) => `$${i + 1}`).join(',')})`,
        Array.from(bundleProviderIds),
      )
      accountDeletions = res.rowCount ?? 0
    } else {
      const res = await client.query(`DELETE FROM resource_plane.provider_accounts`)
      accountDeletions = res.rowCount ?? 0
    }

    // 2. Upsert all bundle data
    for (const acc of newAccounts) {
      await createProviderAccountMetadata(client, { ...acc, ownerNodeId, revision })
    }

    for (const cred of newCredentials) {
      await createTypedCredentialSecret(client, { ...cred, ownerNodeId, revision })
    }

    for (const cap of newCapabilities) {
      await upsertModelCapability(client, { ...cap, revision })
    }

    // 3. Scoped reconciliation within bundle providers (remove stale accounts/creds/caps for bundle providers)
    // Accounts
    for (const providerId of bundleProviderIds) {
      const existingAccounts = await client.query(
        `SELECT provider_id, account_id FROM resource_plane.provider_accounts WHERE provider_id = $1`,
        [providerId],
      )
      const newAccountSet = new Set<string>()
      newAccounts.filter(a => a.providerId === providerId).forEach((acc) => newAccountSet.add(`${acc.providerId}:${acc.accountId}`))
      for (const row of existingAccounts.rows as Array<{ provider_id: string; account_id: string }>) {
        const key = `${row.provider_id}:${row.account_id}`
        if (!newAccountSet.has(key)) {
          if (await deleteProviderAccountMetadata(client, row.provider_id, row.account_id)) accountDeletions++
        }
      }
    }

    // Credentials
    for (const providerId of bundleProviderIds) {
      const existingCredentials = await client.query(
        `SELECT provider_id, account_id, secret_type, secret_id FROM resource_plane.credential_secrets WHERE provider_id = $1`,
        [providerId],
      )
      const newCredentialSet = new Set<string>()
      newCredentials.filter(c => c.providerId === providerId).forEach((cred) =>
        newCredentialSet.add(`${cred.providerId}:${cred.accountId}:${cred.secretType}:${cred.secretId}`),
      )
      for (const row of existingCredentials.rows as Array<{
        provider_id: string; account_id: string; secret_type: ResourceSecretType; secret_id: string
      }>) {
        const key = `${row.provider_id}:${row.account_id}:${row.secret_type}:${row.secret_id}`
        if (!newCredentialSet.has(key)) {
          if (await deleteTypedCredentialSecret(client, row.provider_id, row.account_id, row.secret_type, row.secret_id)) credentialDeletions++
        }
      }
    }

    // Capabilities
    for (const providerId of bundleProviderIds) {
      const existingCapabilities = await client.query(
        `SELECT provider_id, model_id FROM resource_plane.model_capabilities WHERE provider_id = $1`,
        [providerId],
      )
      const newCapabilitySet = new Set<string>()
      newCapabilities.filter(c => c.providerId === providerId).forEach((cap) =>
        newCapabilitySet.add(`${cap.providerId}:${cap.modelId}`),
      )
      for (const row of existingCapabilities.rows as Array<{ provider_id: string; model_id: string }>) {
        const key = `${row.provider_id}:${row.model_id}`
        if (!newCapabilitySet.has(key)) {
          if (await deleteModelCapability(client, row.provider_id, row.model_id)) capabilityDeletions++
        }
      }
    }

    await client.query('COMMIT')

    return {
      accountsUpserted: newAccounts.length,
      accountsDeleted: accountDeletions,
      credentialsUpserted: newCredentials.length,
      credentialsDeleted: credentialDeletions,
      capabilitiesUpserted: newCapabilities.length,
      capabilitiesDeleted: capabilityDeletions,
    }
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    client.release()
  }
}
