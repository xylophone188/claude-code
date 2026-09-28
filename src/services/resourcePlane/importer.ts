import { createHash } from 'node:crypto'
import type { PoolClient } from 'pg'
import {
  createProviderAccountMetadata,
  createTypedCredentialSecret,
  upsertModelCapability,
  type CredentialSecretWrite,
  type ModelCapabilityWrite,
} from './repository.js'
import {
  validateResourceAuthSecretPair,
  type ResourceAuthType,
  type ResourceProviderAccountMetadata,
  type ResourceSecretType,
} from './types.js'

/**
 * Generate a deterministic RFC 4122 v5 UUID from a namespace and seeds.
 * Guaranteed: pure deterministic (no randomUUID), idempotent, matches UUID_PATTERN.
 */
export function deterministicSecretId(
  namespace: string,
  ...parts: (string | number)[]
): string {
  const seed = [namespace, ...parts.map(String)].join(':')
  const hex = createHash('sha256').update(seed, 'utf8').digest('hex')
  const p1 = hex.slice(0, 8)
  const p2 = hex.slice(8, 12)
  const p3 = `5${hex.slice(13, 16)}`
  const variantNibble = (
    (parseInt(hex.slice(16, 17), 16) & 0x3) |
    0x8
  ).toString(16)
  const p4 = `${variantNibble}${hex.slice(17, 20)}`
  const p5 = hex.slice(20, 32)
  return `${p1}-${p2}-${p3}-${p4}-${p5}`
}

export interface ResourcePlaneImportBundle {
  accounts: ResourceProviderAccountMetadata[]
  credentials: CredentialSecretWrite[]
  capabilities: ModelCapabilityWrite[]
}

export interface ProviderJsonAccount {
  id?: string
  name?: string
  apiKey?: string
  model?: string
  tokens?: {
    access_token?: string
    refresh_token?: string
    id_token?: string
    account_id?: string
    [key: string]: unknown
  }
  metadata?: Record<string, unknown>
  [key: string]: unknown
}

export interface ProviderJsonEntry {
  id: string
  kind?: string
  baseUrl?: string
  apiKey?: string
  apiKeyEnv?: string
  defaultModel?: string
  models?: string[]
  reasoningEffortMax?: number
  compatRule?: string
  headers?: Record<string, string>
  accounts?: ProviderJsonAccount[]
  tokens?: {
    access_token?: string
    refresh_token?: string
    id_token?: string
    account_id?: string
    [key: string]: unknown
  }
  [key: string]: unknown
}

export interface ImportBundleResult {
  accountsCount: number
  credentialsCount: number
  capabilitiesCount: number
  providerIds: string[]
  secretIds: string[]
}

export function transformProvidersJson(
  raw: unknown,
  options?: { ownerNodeId?: string },
): ResourcePlaneImportBundle {
  const entries: ProviderJsonEntry[] = Array.isArray(raw)
    ? (raw as ProviderJsonEntry[])
    : raw && typeof raw === 'object'
      ? [raw as ProviderJsonEntry]
      : []

  const accounts: ResourceProviderAccountMetadata[] = []
  const credentials: CredentialSecretWrite[] = []
  const capabilities: ModelCapabilityWrite[] = []
  const seenAccountKeys = new Set<string>()
  const seenSecretKeys = new Set<string>()
  const seenCapabilityKeys = new Set<string>()

  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || !entry.id) {
      continue
    }

    const providerId = String(entry.id).trim()
    const transport = entry.kind || 'openai-compat'
    const baseUrl = entry.baseUrl

    // Gather models for capabilities
    const modelSet = new Set<string>()
    if (entry.defaultModel) modelSet.add(entry.defaultModel)
    if (Array.isArray(entry.models)) {
      for (const m of entry.models) {
        if (typeof m === 'string' && m.trim()) modelSet.add(m.trim())
      }
    }

    // Determine accounts
    const rawAccounts: ProviderJsonAccount[] =
      Array.isArray(entry.accounts) && entry.accounts.length > 0
        ? entry.accounts
        : [
            {
              id: 'default',
              apiKey: entry.apiKey,
              tokens: entry.tokens,
            },
          ]

    for (const acc of rawAccounts) {
      const accountId = String(acc.id || 'default').trim()
      const accountKey = `${providerId}:${accountId}`
      if (acc.model) modelSet.add(acc.model)

      // Determine authType
      const hasOAuth = Boolean(
        acc.tokens?.access_token ||
          acc.tokens?.refresh_token ||
          entry.kind?.toLowerCase().includes('oauth'),
      )
      const authType: ResourceAuthType = hasOAuth ? 'oauth' : 'apiKey'

      // Add account metadata if not already added
      if (!seenAccountKeys.has(accountKey)) {
        seenAccountKeys.add(accountKey)
        const metadata: Record<string, unknown> = {
          ...(entry.reasoningEffortMax !== undefined
            ? { reasoningEffortMax: entry.reasoningEffortMax }
            : {}),
          ...(entry.compatRule ? { compatRule: entry.compatRule } : {}),
          ...(entry.headers ? { headers: entry.headers } : {}),
          ...(entry.apiKeyEnv ? { apiKeyEnv: entry.apiKeyEnv } : {}),
          ...(entry.defaultModel ? { defaultModel: entry.defaultModel } : {}),
          ...(acc.metadata || {}),
        }

        accounts.push({
          providerId,
          accountId,
          name:
            acc.name ||
            (accountId === 'default'
              ? providerId
              : `${providerId}-${accountId}`),
          authType,
          transport,
          baseUrl,
          enabled: true,
          ownerNodeId: options?.ownerNodeId,
          metadata,
          revision: 1,
          updatedAt: new Date(),
        })
      }

      // Process secrets
      if (
        authType === 'apiKey' &&
        acc.apiKey &&
        typeof acc.apiKey === 'string'
      ) {
        const secretType: ResourceSecretType = 'apiKey'
        validateResourceAuthSecretPair(authType, secretType)
        const secretId = deterministicSecretId(
          'resource_plane:secret',
          providerId,
          accountId,
          secretType,
        )
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
              type: 'apiKey',
              apiKey: acc.apiKey,
            },
            revision: 1,
            ownerNodeId: options?.ownerNodeId,
            refreshable: false,
          })
        }
      } else if (authType === 'oauth' && acc.tokens) {
        // OAuth tokens must maintain separate secretType: accessToken, refreshToken
        // STRICT: Never map to apiKey
        const tokens = acc.tokens

        if (tokens.access_token) {
          const secretType: ResourceSecretType = 'accessToken'
          validateResourceAuthSecretPair(authType, secretType)
          const secretId = deterministicSecretId(
            'resource_plane:secret',
            providerId,
            accountId,
            secretType,
          )
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
                accessToken: tokens.access_token,
                refreshToken: tokens.refresh_token,
                idToken: tokens.id_token,
              },
              revision: 1,
              ownerNodeId: options?.ownerNodeId,
              refreshable: Boolean(tokens.refresh_token),
            })
          }
        }

        if (tokens.refresh_token) {
          const secretType: ResourceSecretType = 'refreshToken'
          validateResourceAuthSecretPair(authType, secretType)
          const secretId = deterministicSecretId(
            'resource_plane:secret',
            providerId,
            accountId,
            secretType,
          )
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
                accessToken: tokens.access_token || '',
                refreshToken: tokens.refresh_token,
                idToken: tokens.id_token,
              },
              revision: 1,
              ownerNodeId: options?.ownerNodeId,
              refreshable: true,
            })
          }
        }
      }
    }

    // Add model capabilities
    for (const modelId of modelSet) {
      const capKey = `${providerId}:${modelId}`
      if (!seenCapabilityKeys.has(capKey)) {
        seenCapabilityKeys.add(capKey)
        capabilities.push({
          providerId,
          modelId,
          capabilities: {
            supportsStreaming: true,
            ...(entry.reasoningEffortMax !== undefined
              ? { reasoningEffortMax: entry.reasoningEffortMax }
              : {}),
          },
          limits: {},
          revision: 1,
        })
      }
    }
  }

  return { accounts, credentials, capabilities }
}

/**
 * Import bundle into Resource Plane PostgreSQL tables.
 * Guaranteed: idempotent on identical input, all secrets written via createTypedCredentialSecret (rpenc:v1).
 */
export async function importResourcePlaneBundle(
  tx: PoolClient,
  bundle: ResourcePlaneImportBundle,
): Promise<ImportBundleResult> {
  const providerIdSet = new Set<string>()
  const secretIdSet = new Set<string>()

  // 1. Accounts
  for (const account of bundle.accounts) {
    providerIdSet.add(account.providerId)
    await createProviderAccountMetadata(tx, account)
  }

  // 2. Model capabilities
  for (const capability of bundle.capabilities) {
    await upsertModelCapability(tx, capability)
  }

  // 3. Credential secrets (always encrypted through rpenc:v1)
  for (const credential of bundle.credentials) {
    secretIdSet.add(credential.secretId)
    await createTypedCredentialSecret(tx, credential)
  }

  return {
    accountsCount: bundle.accounts.length,
    credentialsCount: bundle.credentials.length,
    capabilitiesCount: bundle.capabilities.length,
    providerIds: Array.from(providerIdSet),
    secretIds: Array.from(secretIdSet),
  }
}

/**
 * Audit helper: verifies that given plaintext secrets do not leak into non-secret fields.
 */
export function assertNoPlaintextLeak(
  inspected: unknown,
  plaintextSecrets: string[],
  context = 'root',
): void {
  const needleList = plaintextSecrets.filter(
    s => typeof s === 'string' && s.length >= 6,
  )
  if (needleList.length === 0) return

  const inspectValue = (val: unknown, path: string): void => {
    if (val === null || val === undefined) return
    if (typeof val === 'string') {
      for (const needle of needleList) {
        if (val.includes(needle)) {
          throw new Error(
            `Plaintext secret leak detected at ${path}: value contains forbidden secret`,
          )
        }
      }
      return
    }
    if (Array.isArray(val)) {
      val.forEach((item, idx) => inspectValue(item, `${path}[${idx}]`))
      return
    }
    if (typeof val === 'object') {
      for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
        // Skip explicitly encrypted fields or the secret input value in raw write payloads
        if (k === 'encryptedSecret' || k === 'value') continue
        inspectValue(v, `${path}.${k}`)
      }
    }
  }

  inspectValue(inspected, context)
}
