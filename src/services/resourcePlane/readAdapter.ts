/**
 * Resource Plane Read Adapter for CCB Runtime.
 *
 * Provides a read-only bridge from PostgreSQL `resource_plane.*` tables
 * to CCB runtime ProviderConfig and capability models.
 *
 * Security & Separation of Concerns:
 * - Default read path: non-sensitive metadata only (accounts, models, baseUrls, transports).
 * - Credentials remain encrypted at rest in `resource_plane.credential_secrets`.
 * - Explicit decryption is strictly isolated to `resolveTransportCredential()` at the
 *   network transport boundary, or when `decryptCredentials: true` is explicitly opted in.
 */

import type { Pool, PoolClient } from 'pg'
import { getPgPool } from '../pg/pool.js'
import { decryptTypedCredential } from './credentials.js'
import type { ProviderConfig } from '../providerRegistry/types.js'
import type {
  ResourceAuthType,
  ResourceProviderAccountMetadata,
  ResourceSecretType,
} from './types.js'

export interface ResourcePlaneReadOptions {
  pool?: Pool | PoolClient
  decryptCredentials?: boolean
  ownerNodeId?: string
}

let _cachedProviders: ProviderConfig[] | null = null
let _cacheLoadedAt = 0
const CACHE_TTL_MS = 30_000

export function invalidateResourcePlaneCache(): void {
  _cachedProviders = null
  _cacheLoadedAt = 0
}

/**
 * Read active provider configurations from resource_plane schema.
 * Pure read-only operation; returns empty array if tables missing or PG offline.
 */
export async function loadProvidersFromResourcePlane(
  options: ResourcePlaneReadOptions = {},
): Promise<ProviderConfig[]> {
  const now = Date.now()
  if (
    !options.pool &&
    !options.decryptCredentials &&
    _cachedProviders &&
    now - _cacheLoadedAt < CACHE_TTL_MS
  ) {
    return _cachedProviders
  }

  const client = options.pool ?? getPgPool()
  try {
    // 1. Fetch enabled provider accounts
    const accountQuery = `
      SELECT provider_id, account_id, name, auth_type, transport, base_url,
             owner_node_id, enabled, metadata, revision, updated_at
      FROM resource_plane.provider_accounts
      WHERE enabled = true
      ORDER BY provider_id, account_id
    `
    const accountRes = await client.query<
      ResourceProviderAccountMetadata & {
        provider_id: string
        account_id: string
        auth_type: string
        base_url: string | null
      }
    >(accountQuery)
    if (!accountRes.rows.length) {
      return []
    }

    // 2. Fetch model capabilities
    const capQuery = `
      SELECT provider_id, model_id, capabilities, limits, revision, updated_at
      FROM resource_plane.model_capabilities
      ORDER BY provider_id, model_id
    `
    const capRes = await client.query<{
      provider_id: string
      model_id: string
      capabilities: Record<string, unknown>
      limits: Record<string, unknown>
    }>(capQuery)

    // Group capabilities by provider
    const modelsByProvider = new Map<string, string[]>()
    for (const row of capRes.rows) {
      const arr = modelsByProvider.get(row.provider_id) ?? []
      if (!arr.includes(row.model_id)) {
        arr.push(row.model_id)
      }
      modelsByProvider.set(row.provider_id, arr)
    }

    // 3. Optional credential resolution (only if explicitly requested at transport boundary)
    const secretsByProviderAccount = new Map<string, string>()
    if (options.decryptCredentials) {
      const secretQuery = `
        SELECT provider_id, account_id, secret_type, auth_type, secret_id,
               key_version, encrypted_secret, expires_at, refreshable, metadata, revision
        FROM resource_plane.credential_secrets
        ORDER BY provider_id, account_id, secret_type
      `
      const secretRes = await client.query<{
        provider_id: string
        account_id: string
        secret_type: ResourceSecretType
        auth_type: ResourceAuthType
        secret_id: string
        key_version: number
        encrypted_secret: string
        revision: number
      }>(secretQuery)

      for (const row of secretRes.rows) {
        try {
          const decrypted = await decryptTypedCredential({
            providerId: row.provider_id,
            accountId: row.account_id,
            authType: row.auth_type,
            secretType: row.secret_type,
            keyVersion: row.key_version,
            encryptedSecret: row.encrypted_secret,
          })
          const plain =
            decrypted.type === 'apiKey'
              ? decrypted.apiKey
              : decrypted.type === 'oauth'
                ? decrypted.accessToken
                : undefined
          if (plain) {
            const key = `${row.provider_id}:${row.account_id}`
            // Prioritize primary secret
            if (
              !secretsByProviderAccount.has(key) ||
              row.secret_type === 'apiKey' ||
              row.secret_type === 'accessToken'
            ) {
              secretsByProviderAccount.set(key, plain)
            }
          }
        } catch {
          // Keep resilient: failed decryption does not fail the entire provider catalog
        }
      }
    }

    // Group accounts by provider_id
    const accountsByProvider = new Map<string, typeof accountRes.rows>()
    for (const acc of accountRes.rows) {
      const arr = accountsByProvider.get(acc.provider_id) ?? []
      arr.push(acc)
      accountsByProvider.set(acc.provider_id, arr)
    }

    const providers: ProviderConfig[] = []

    for (const [providerId, accList] of accountsByProvider.entries()) {
      const primaryAcc = accList[0]
      const meta = (primaryAcc.metadata ?? {}) as Record<string, unknown>
      const models = modelsByProvider.get(providerId) ?? []
      const defaultModel =
        typeof meta.defaultModel === 'string' && meta.defaultModel
          ? meta.defaultModel
          : models[0] || `${providerId}/default`

      const accountsConfig: NonNullable<ProviderConfig['accounts']> =
        accList.map(a => {
          const accMeta = (a.metadata ?? {}) as Record<string, unknown>
          const key = `${a.provider_id}:${a.account_id}`
          const decryptedKey = secretsByProviderAccount.get(key)
          const envKey =
            typeof accMeta.apiKeyEnv === 'string'
              ? accMeta.apiKeyEnv
              : undefined
          const fixedModel =
            typeof accMeta.model === 'string' ? accMeta.model : undefined

          return {
            id: a.account_id,
            enabled: a.enabled,
            ...(decryptedKey ? { apiKey: decryptedKey } : {}),
            ...(envKey ? { apiKeyEnv: envKey } : {}),
            ...(fixedModel ? { model: fixedModel } : {}),
          }
        })

      const baseUrl =
        primaryAcc.base_url || `https://api.${providerId}.example.invalid/v1`
      const compatRule = (
        typeof meta.compatRule === 'string' ? meta.compatRule : 'permissive'
      ) as ProviderConfig['compatRule']
      const headers =
        meta.headers && typeof meta.headers === 'object'
          ? (meta.headers as Record<string, string>)
          : undefined
      const timeoutMs =
        typeof meta.timeoutMs === 'number' ? meta.timeoutMs : undefined
      const reasoningEffortMax =
        typeof meta.reasoningEffortMax === 'string'
          ? (meta.reasoningEffortMax as ProviderConfig['reasoningEffortMax'])
          : undefined

      providers.push({
        id: providerId,
        kind: 'openai-compat',
        baseUrl,
        defaultModel,
        compatRule,
        ...(models.length ? { models } : {}),
        ...(accountsConfig.length ? { accounts: accountsConfig } : {}),
        ...(headers ? { headers } : {}),
        ...(timeoutMs ? { timeoutMs } : {}),
        ...(reasoningEffortMax ? { reasoningEffortMax } : {}),
      })
    }

    if (!options.pool && !options.decryptCredentials) {
      _cachedProviders = providers
      _cacheLoadedAt = now
    }

    return providers
  } catch {
    // If PG is unreachable or table doesn't exist, return empty array for graceful fallback
    return []
  }
}

/**
 * Dedicated single-credential resolution at the network transport boundary.
 * Never decrypts the whole table — only the exact credential needed for an outbound request.
 */
export async function resolveTransportCredential(
  providerId: string,
  accountId: string,
  secretType?: ResourceSecretType,
  poolOrClient?: Pool | PoolClient,
): Promise<string | undefined> {
  const client = poolOrClient ?? getPgPool()
  try {
    const query = secretType
      ? `SELECT provider_id, account_id, secret_type, auth_type, secret_id,
                key_version, encrypted_secret, revision
         FROM resource_plane.credential_secrets
         WHERE provider_id = $1 AND account_id = $2 AND secret_type = $3
         LIMIT 1`
      : `SELECT provider_id, account_id, secret_type, auth_type, secret_id,
                key_version, encrypted_secret, revision
         FROM resource_plane.credential_secrets
         WHERE provider_id = $1 AND account_id = $2
         ORDER BY CASE secret_type WHEN 'apiKey' THEN 1 WHEN 'accessToken' THEN 2 ELSE 3 END
         LIMIT 1`
    const params = secretType
      ? [providerId, accountId, secretType]
      : [providerId, accountId]
    const res = await client.query<{
      provider_id: string
      account_id: string
      secret_type: ResourceSecretType
      auth_type: ResourceAuthType
      secret_id: string
      key_version: number
      encrypted_secret: string
      revision: number
    }>(query, params)

    if (!res.rows.length) {
      return undefined
    }

    const row = res.rows[0]
    const decrypted = await decryptTypedCredential({
      providerId: row.provider_id,
      accountId: row.account_id,
      authType: row.auth_type,
      secretType: row.secret_type,
      keyVersion: row.key_version,
      encryptedSecret: row.encrypted_secret,
    })

    if (decrypted.type === 'apiKey') {
      return decrypted.apiKey
    }
    if (decrypted.type === 'oauth') {
      return decrypted.accessToken
    }
    return undefined
  } catch {
    return undefined
  }
}
