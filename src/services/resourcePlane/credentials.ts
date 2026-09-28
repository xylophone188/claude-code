import {
  credentialSecretToStoredValue,
  storedValueToCredentialSecret,
  validateResourceAuthSecretPair,
  ResourcePlaneValidationError,
  type CredentialSecretInput,
  type CredentialSecretValue,
  type ResourceAuthType,
  type ResourceSecretType,
} from './types.js'
import { decryptResourceSecret, encryptResourceSecret } from './secretKey.js'

const KEY_VERSION = 1

export interface ResourcePlaneSecretContext {
  providerId: string
  accountId: string
  authType: ResourceAuthType
  secretType: ResourceSecretType
  keyVersion?: number
}

function secretAad(
  input: Pick<
    ResourcePlaneSecretContext,
    'providerId' | 'accountId' | 'secretType'
  > & {
    authType: ResourceAuthType
  },
  keyVersion: number = KEY_VERSION,
): string {
  return [
    'resource_plane',
    'credential',
    input.providerId,
    input.accountId,
    input.secretType,
    `keyVersion:${keyVersion}`,
  ].join('|')
}

export async function encryptTypedCredential(
  input: CredentialSecretInput,
): Promise<{ encryptedSecret: string }> {
  validateResourceAuthSecretPair(input.authType, input.secretType)
  const stored = credentialSecretToStoredValue(input.value)
  const plaintext = JSON.stringify(stored)
  return {
    encryptedSecret: await encryptResourceSecret(
      plaintext,
      secretAad(input, input.keyVersion ?? KEY_VERSION),
    ),
  }
}

export async function decryptTypedCredential<
  T extends CredentialSecretValue = CredentialSecretValue,
>(input: ResourcePlaneSecretContext & { encryptedSecret: string }): Promise<T> {
  validateResourceAuthSecretPair(input.authType, input.secretType)
  const keyVersion = input.keyVersion ?? KEY_VERSION
  const plaintext = await decryptResourceSecret(
    input.encryptedSecret,
    secretAad(input, keyVersion),
  )
  let stored: Record<string, string>
  try {
    stored = JSON.parse(plaintext) as Record<string, string>
  } catch {
    throw new ResourcePlaneValidationError(
      'credential payload is not valid JSON',
    )
  }
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
    throw new ResourcePlaneValidationError(
      'credential payload must be an object',
    )
  }
  return storedValueToCredentialSecret(
    input.authType,
    input.secretType,
    stored,
  ) as T
}
