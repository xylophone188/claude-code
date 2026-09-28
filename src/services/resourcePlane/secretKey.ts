import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scryptSync,
} from 'node:crypto'

const ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12
const TAG_BYTES = 16
const KEY_BYTES = 32
const SALT = 'ccb-resource-plane-v1'
const PREFIX = 'rpenc'
const FORMAT_VERSION = 'v1'
const KEY_VERSION = 1

export class ResourceSecretKeyError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ResourceSecretKeyError'
  }
}

function readEnvKeyMaterial(): string | undefined {
  return (
    process.env['CCB_RESOURCE_PLANE_KEY'] ??
    process.env['CCB_STORAGE_ENCRYPTION_KEY'] ??
    process.env['OMNIROUTE_STORAGE_ENCRYPTION_KEY'] ??
    process.env['OMNIROUTE_ENCRYPTION_KEY']
  )
}

let cachedVaultKey: string | undefined

/**
 * LocalVault holds the operator's keychain/encrypted-file key. It is the PC
 * key source; env vars stay first so tests and operators can override. Nothing
 * here ever falls back to an embedded default. The vault read is cached
 * per-process because it costs a keychain hop.
 */
async function readVaultKeyMaterial(): Promise<string | undefined> {
  if (cachedVaultKey !== undefined) return cachedVaultKey
  try {
    const { getSecret } = await import('../localVault/store.js')
    cachedVaultKey = (await getSecret('resourcePlane.key')) ?? undefined
    return cachedVaultKey
  } catch {
    return undefined
  }
}

async function readKeyMaterial(): Promise<string | undefined> {
  const fromEnv = readEnvKeyMaterial()
  if (fromEnv) return fromEnv
  return readVaultKeyMaterial()
}

export function hasResourceSecretKey(): boolean {
  return Boolean(readEnvKeyMaterial())
}

/** Env-backed check only; async because LocalVault adds a keychain hop. */
export async function hasResourceSecretKeyAsync(): Promise<boolean> {
  return Boolean(await readKeyMaterial())
}

/**
 * Return the derived AES-GCM key as a hex string, for callers that need the
 * same key material for HMAC signing (signed audit chain). Derives from the
 * same source as encryption so signatures and ciphertext share one key source.
 */
export async function getResourceSecretKeyAsync(): Promise<string> {
  const key = await deriveKey()
  try {
    return key.toString('hex')
  } finally {
    key.fill(0)
  }
}

async function deriveKey(): Promise<Buffer> {
  const material = await readKeyMaterial()
  if (!material) {
    throw new ResourceSecretKeyError(
      'Resource Plane key material is required for Resource Plane secrets',
    )
  }
  return scryptSync(material, SALT, KEY_BYTES, {
    N: 16384,
    r: 8,
    p: 1,
  }) as Buffer
}

export async function encryptResourceSecret(
  plaintext: string,
  aad: string,
): Promise<string> {
  if (Buffer.byteLength(plaintext, 'utf8') === 0) {
    throw new ResourceSecretKeyError('Resource Plane secret must be non-empty')
  }
  const iv = randomBytes(IV_BYTES)
  const key = await deriveKey()
  try {
    const cipher = createCipheriv(ALGORITHM, key, iv)
    cipher.setAAD(Buffer.from(aad, 'utf8'))
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ])
    return [
      PREFIX,
      FORMAT_VERSION,
      String(KEY_VERSION),
      ALGORITHM,
      iv.toString('hex'),
      ciphertext.toString('hex'),
      cipher.getAuthTag().toString('hex'),
    ].join(':')
  } finally {
    key.fill(0)
  }
}

export async function decryptResourceSecret(
  envelope: string,
  aad: string,
): Promise<string> {
  const parts = envelope.split(':')
  if (
    parts.length !== 7 ||
    parts[0] !== PREFIX ||
    parts[1] !== FORMAT_VERSION ||
    parts[2] !== String(KEY_VERSION) ||
    parts[3] !== ALGORITHM
  ) {
    throw new ResourceSecretKeyError('invalid Resource Plane secret envelope')
  }
  const [, , , , ivHex, ciphertextHex, tagHex] = parts
  const iv = Buffer.from(ivHex, 'hex')
  const ciphertext = Buffer.from(ciphertextHex, 'hex')
  const authTag = Buffer.from(tagHex, 'hex')
  if (
    iv.length !== IV_BYTES ||
    ciphertext.length !== ciphertextHex.length / 2 ||
    authTag.length !== TAG_BYTES
  ) {
    throw new ResourceSecretKeyError('invalid Resource Plane secret encoding')
  }
  const key = await deriveKey()
  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv)
    decipher.setAuthTag(authTag)
    decipher.setAAD(Buffer.from(aad, 'utf8'))
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ])
    return new TextDecoder('utf-8', { fatal: true }).decode(plaintext)
  } catch (err) {
    if (err instanceof ResourceSecretKeyError) throw err
    throw new ResourceSecretKeyError(
      'Resource Plane secret authentication failed',
    )
  } finally {
    key.fill(0)
  }
}
