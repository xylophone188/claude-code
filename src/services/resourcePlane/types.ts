export const RESOURCE_AUTH_TYPES = [
  'apiKey',
  'oauth',
  'mtls',
  'basic',
  'custom',
] as const

export type ResourceAuthType = (typeof RESOURCE_AUTH_TYPES)[number]

export const RESOURCE_SECRET_TYPES = [
  'apiKey',
  'accessToken',
  'refreshToken',
  'idToken',
  'clientSecret',
  'password',
  'certificate',
  'custom',
] as const

export type ResourceSecretType = (typeof RESOURCE_SECRET_TYPES)[number]

export interface ResourceProviderAccountMetadata {
  providerId: string
  accountId: string
  name?: string
  authType: ResourceAuthType
  transport?: string
  baseUrl?: string
  ownerNodeId?: string
  enabled: boolean
  metadata?: Record<string, unknown>
  revision: number
  updatedByNodeId?: string
  updatedAt: Date
}

export interface ResourceModelCapability {
  providerId: string
  modelId: string
  capabilities: Record<string, unknown>
  limits: Record<string, unknown>
  revision: number
}

export interface ResourceProviderHealth {
  providerId: string
  accountId?: string
  modelId?: string
  health: Record<string, unknown>
  updatedAt: Date
}

export interface ResourceQuotaState {
  providerId: string
  accountId?: string
  quota: Record<string, unknown>
  revision: number
  updatedAt: Date
}

export interface ResourceRoutingResource {
  resourceKey: string
  resource: Record<string, unknown>
  revision: number
  ownerNodeId?: string
  updatedAt: Date
}

export interface ResourceDeviceResource {
  nodeId: string
  device: Record<string, unknown>
  updatedAt: Date
}

export interface ResourceSyncMetadata {
  nodeId: string
  lastAppliedRevision: number
  lastSyncedAt: Date
  fencingEpoch: number
}

export interface TypedCredentialRecord {
  providerId: string
  accountId: string
  authType: ResourceAuthType
  secretType: ResourceSecretType
  secretId: string
  keyVersion: number
  encryptedSecret: string
  expiresAt?: Date | null
  refreshable: boolean
  metadata: Record<string, unknown>
  revision: number
  ownerNodeId?: string
  updatedAt: Date
}

export interface ApiKeyCredentialSecret {
  type: 'apiKey'
  apiKey: string
}

export interface OAuthCredentialSecret {
  type: 'oauth'
  accessToken: string
  refreshToken?: string
  idToken?: string
  clientSecret?: string
}

export interface CustomCredentialSecret {
  type: 'custom'
  secrets: Record<string, string>
}

export type CredentialSecretValue =
  | ApiKeyCredentialSecret
  | OAuthCredentialSecret
  | CustomCredentialSecret

export interface CredentialSecretInput {
  providerId: string
  accountId: string
  authType: ResourceAuthType
  secretType: ResourceSecretType
  secretId: string
  value: CredentialSecretValue
  expiresAt?: Date | null
  refreshable?: boolean
  metadata?: Record<string, unknown>
  revision: number
  ownerNodeId?: string
  keyVersion?: number
}

export class ResourcePlaneValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ResourcePlaneValidationError'
  }
}

export function isResourceAuthType(value: unknown): value is ResourceAuthType {
  return (
    typeof value === 'string' &&
    (RESOURCE_AUTH_TYPES as readonly string[]).includes(value)
  )
}

export function isResourceSecretType(
  value: unknown,
): value is ResourceSecretType {
  return (
    typeof value === 'string' &&
    (RESOURCE_SECRET_TYPES as readonly string[]).includes(value)
  )
}

export function validateResourceAuthSecretPair(
  authType: ResourceAuthType,
  secretType: ResourceSecretType,
): void {
  if (authType === 'apiKey') {
    if (secretType !== 'apiKey') {
      throw new ResourcePlaneValidationError(
        `authType apiKey requires secretType apiKey, got ${secretType}`,
      )
    }
    return
  }
  if (authType === 'oauth') {
    if (secretType === 'apiKey') {
      throw new ResourcePlaneValidationError(
        'OAuth authType must not use apiKey secretType',
      )
    }
    if (
      !['accessToken', 'refreshToken', 'idToken', 'clientSecret'].includes(
        secretType,
      )
    ) {
      throw new ResourcePlaneValidationError(
        `OAuth authType does not support secretType ${secretType}`,
      )
    }
    return
  }
  if (authType === 'mtls' && secretType !== 'certificate') {
    throw new ResourcePlaneValidationError(
      `mTLS authType requires secretType certificate, got ${secretType}`,
    )
  }
  if (authType === 'basic' && secretType !== 'password') {
    throw new ResourcePlaneValidationError(
      `basic authType requires secretType password, got ${secretType}`,
    )
  }
  if (authType === 'custom' && secretType !== 'custom') {
    throw new ResourcePlaneValidationError(
      `custom authType requires secretType custom, got ${secretType}`,
    )
  }
}

export function redactCredentialRecord(
  record: TypedCredentialRecord,
): Omit<TypedCredentialRecord, 'encryptedSecret'> {
  const { encryptedSecret: _encryptedSecret, ...safe } = record
  return safe
}

export function credentialSecretToStoredValue(
  value: CredentialSecretValue,
): Record<string, string> {
  if (value.type === 'apiKey') {
    validateRequired(value.apiKey, 'apiKey')
    return { apiKey: value.apiKey }
  }
  if (value.type === 'oauth') {
    validateRequired(value.accessToken, 'accessToken')
    return Object.fromEntries(
      (
        [
          ['accessToken', value.accessToken],
          ['refreshToken', value.refreshToken],
          ['idToken', value.idToken],
          ['clientSecret', value.clientSecret],
        ] as const
      ).filter(
        (
          entry,
        ): entry is [
          'accessToken' | 'refreshToken' | 'idToken' | 'clientSecret',
          string,
        ] => typeof entry[1] === 'string' && entry[1].length > 0,
      ),
    )
  }
  if (Object.keys(value.secrets).length === 0) {
    throw new ResourcePlaneValidationError(
      'custom credential must contain at least one secret',
    )
  }
  return Object.fromEntries(
    Object.entries(value.secrets).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === 'string' && entry[1].length > 0,
    ),
  )
}

export function storedValueToCredentialSecret(
  authType: ResourceAuthType,
  secretType: ResourceSecretType,
  stored: Record<string, string>,
): CredentialSecretValue {
  if (authType === 'apiKey' && secretType === 'apiKey') {
    return { type: 'apiKey', apiKey: stored.apiKey ?? '' }
  }
  if (authType === 'oauth') {
    return {
      type: 'oauth',
      accessToken: stored.accessToken ?? '',
      ...(stored.refreshToken ? { refreshToken: stored.refreshToken } : {}),
      ...(stored.idToken ? { idToken: stored.idToken } : {}),
      ...(stored.clientSecret ? { clientSecret: stored.clientSecret } : {}),
    }
  }
  return { type: 'custom', secrets: { ...stored } }
}

function validateRequired(value: string, label: string): void {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ResourcePlaneValidationError(
      `${label} must be a non-empty string`,
    )
  }
}
