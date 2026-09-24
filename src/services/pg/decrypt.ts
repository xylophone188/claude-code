/**
 * AES-256-GCM credential decryption matching OmniRoute's `enc:v1:` format.
 *
 * Format: `enc:v1:<ivHex>:<ciphertextHex>:<authTagHex>`
 * Key derivation: `scrypt(key, 'omniroute-field-encryption-v1', 32)`.
 *
 * Reuses the same salt as `src/services/api/openai/chatgptAuth.ts` so both
 * paths decrypt OmniRoute's stored tokens interchangeably.
 */

import { createDecipheriv, scryptSync } from 'node:crypto'

export const OMNIROUTE_CREDENTIAL_PREFIX = 'enc:v1:'
export const OMNIROUTE_CREDENTIAL_SALT = 'omniroute-field-encryption-v1'

function readEncryptionKey(): string | undefined {
  return (
    process.env.OMNIROUTE_STORAGE_ENCRYPTION_KEY ??
    process.env.OMNIROUTE_ENCRYPTION_KEY ??
    process.env.CCB_STORAGE_ENCRYPTION_KEY
  )
}

export function decryptCredential(value: string | null | undefined): string {
  if (!value) return ''
  if (!value.startsWith(OMNIROUTE_CREDENTIAL_PREFIX)) return value
  const key = readEncryptionKey()
  if (!key) {
    throw new Error(
      'Encrypted OmniRoute credential requires OMNIROUTE_STORAGE_ENCRYPTION_KEY.',
    )
  }
  const parts = value.slice(OMNIROUTE_CREDENTIAL_PREFIX.length).split(':')
  const [ivHex, encryptedHex, authTagHex] = parts
  if (!ivHex || !encryptedHex || !authTagHex) {
    throw new Error('Malformed OmniRoute credential.')
  }
  const decipher = createDecipheriv(
    'aes-256-gcm',
    scryptSync(key, OMNIROUTE_CREDENTIAL_SALT, 32),
    Buffer.from(ivHex, 'hex'),
    { authTagLength: 16 },
  )
  const ctBuffer = Buffer.from(encryptedHex, 'hex')
  decipher.setAuthTag(Buffer.from(authTagHex, 'hex'))
  return decipher.update(ctBuffer, undefined, 'utf8') + decipher.final('utf8')
}

/** Best-effort decrypt for pool loading: returns '' on failure, never throws. */
export function decryptCredentialSafe(value: string | null | undefined): string {
  if (!value) return ''
  if (!value.startsWith(OMNIROUTE_CREDENTIAL_PREFIX)) return value
  try {
    return decryptCredential(value)
  } catch {
    return ''
  }
}

/** Returns true if at least one decryption key is configured in the environment. */
export function hasEncryptionKey(): boolean {
  return Boolean(readEncryptionKey())
}
