import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  decryptTypedCredential,
  encryptTypedCredential,
} from '../credentials.js'
import {
  decryptResourceSecret,
  encryptResourceSecret,
  hasResourceSecretKey,
  ResourceSecretKeyError,
} from '../secretKey.js'
import { ResourcePlaneValidationError } from '../types.js'

const TEST_KEY = 'resource-plane-unit-test-key-do-not-use-in-prod'

beforeEach(() => {
  process.env['CCB_RESOURCE_PLANE_KEY'] = TEST_KEY
})

afterEach(() => {
  delete process.env['CCB_RESOURCE_PLANE_KEY']
})

describe('secretKey envelope', () => {
  test('exposes env-backed key availability', () => {
    expect(hasResourceSecretKey()).toBe(true)
  })

  test('round-trips a plaintext payload', async () => {
    const envelope = await encryptResourceSecret(
      '{"accessToken":"a"}',
      'resource_plane|credential',
    )
    expect(envelope.startsWith('rpenc:v1:1:aes-256-gcm:')).toBe(true)
    expect(
      await decryptResourceSecret(envelope, 'resource_plane|credential'),
    ).toBe('{"accessToken":"a"}')
  })

  test('AAD mismatch fails authentication instead of returning data', async () => {
    const envelope = await encryptResourceSecret('secret', 'aad-1')
    await expect(decryptResourceSecret(envelope, 'aad-2')).rejects.toThrow(
      /authentication failed/,
    )
  })

  test('tampered ciphertext fails authentication', async () => {
    const envelope = await encryptResourceSecret('secret', 'aad')
    const parts = envelope.split(':')
    parts[4] = 'f'.repeat(parts[4].length)
    await expect(decryptResourceSecret(parts.join(':'), 'aad')).rejects.toThrow(
      /authentication failed/,
    )
  })

  test('rejects malformed envelopes', async () => {
    await expect(decryptResourceSecret('garbage', 'aad')).rejects.toThrow(
      /invalid Resource Plane secret envelope/,
    )
    await expect(
      decryptResourceSecret('rpenc:v9:1:aes-256-gcm:a:b:c', 'aad'),
    ).rejects.toThrow(ResourceSecretKeyError)
  })

  test('rejects empty plaintext', async () => {
    await expect(encryptResourceSecret('', 'aad')).rejects.toThrow(
      /must be non-empty/,
    )
  })

  test('each encryption uses a fresh IV', async () => {
    const a = await encryptResourceSecret('same', 'aad')
    const b = await encryptResourceSecret('same', 'aad')
    expect(a).not.toBe(b)
    expect(a.split(':')[4]).not.toBe(b.split(':')[4])
  })

  test('rejects when no key material is available anywhere', async () => {
    delete process.env['CCB_RESOURCE_PLANE_KEY']
    delete process.env['CCB_STORAGE_ENCRYPTION_KEY']
    delete process.env['OMNIROUTE_STORAGE_ENCRYPTION_KEY']
    delete process.env['OMNIROUTE_ENCRYPTION_KEY']
    expect(hasResourceSecretKey()).toBe(false)
    await expect(encryptResourceSecret('x', 'aad')).rejects.toThrow(
      ResourceSecretKeyError,
    )
  })
})

describe('typed credential encryption', () => {
  test('round-trips an apiKey credential', async () => {
    const input = {
      providerId: 'anthropic',
      accountId: 'acct-1',
      authType: 'apiKey' as const,
      secretType: 'apiKey' as const,
      secretId: '11111111-1111-4111-8111-111111111111',
      value: { type: 'apiKey' as const, apiKey: 'sk-ant-test' },
      revision: 1,
    }
    const { encryptedSecret } = await encryptTypedCredential(input)
    expect(encryptedSecret).not.toContain('sk-ant-test')
    const decrypted = await decryptTypedCredential({
      ...input,
      encryptedSecret,
    })
    expect(decrypted).toEqual({ type: 'apiKey', apiKey: 'sk-ant-test' })
  })

  test('round-trips an OAuth token set without apiKey folding', async () => {
    const value = {
      type: 'oauth' as const,
      accessToken: 'access-123',
      refreshToken: 'refresh-456',
    }
    const input = {
      providerId: 'codex',
      accountId: 'user-1',
      authType: 'oauth' as const,
      secretType: 'accessToken' as const,
      secretId: '22222222-2222-4222-8222-222222222222',
      value,
      revision: 1,
    }
    const { encryptedSecret } = await encryptTypedCredential(input)
    expect(encryptedSecret).not.toContain('access-123')
    const decrypted = await decryptTypedCredential({
      ...input,
      encryptedSecret,
    })
    expect(decrypted).toEqual(value)
    expect(Object.hasOwn(decrypted, 'apiKey')).toBe(false)
  })

  test('round-trips custom secrets', async () => {
    const value = {
      type: 'custom' as const,
      secrets: { username: 'svc', password: 'pw' },
    }
    const input = {
      providerId: 'gitlab',
      accountId: 'self-hosted',
      authType: 'custom' as const,
      secretType: 'custom' as const,
      secretId: '33333333-3333-4333-8333-333333333333',
      value,
      revision: 1,
    }
    const { encryptedSecret } = await encryptTypedCredential(input)
    expect(await decryptTypedCredential({ ...input, encryptedSecret })).toEqual(
      value,
    )
  })

  test('rejects OAuth secret material under apiKey secretType', async () => {
    await expect(
      encryptTypedCredential({
        providerId: 'codex',
        accountId: 'a',
        authType: 'oauth',
        secretType: 'apiKey',
        secretId: '11111111-1111-4111-8111-111111111111',
        value: { type: 'oauth', accessToken: 'x' },
        revision: 1,
      }),
    ).rejects.toThrow(ResourcePlaneValidationError)
  })

  test('AAD binds the secret to provider/account/secretType', async () => {
    const base = {
      providerId: 'p1',
      accountId: 'a1',
      secretType: 'accessToken' as const,
      secretId: '11111111-1111-4111-8111-111111111111',
      value: { type: 'oauth' as const, accessToken: 'tok' },
      authType: 'oauth' as const,
      revision: 1,
    }
    const { encryptedSecret } = await encryptTypedCredential(base)
    const swapped = { ...base, accountId: 'a2' }
    await expect(
      decryptTypedCredential({ ...swapped, encryptedSecret }),
    ).rejects.toThrow(/authentication failed/)
  })

  test('AAD cannot be spoofed by injecting a pipe-delimited segment', async () => {
    const base = {
      providerId: 'p1',
      accountId: 'a1',
      secretType: 'apiKey' as const,
      secretId: '11111111-1111-4111-8111-111111111111',
      value: { type: 'apiKey' as const, apiKey: 'k' },
      authType: 'apiKey' as const,
      revision: 1,
    }
    const { encryptedSecret } = await encryptTypedCredential(base)
    const forgedProviderId =
      'p1|credential|p1|a1|apiKey|keyVersion:1|attacker-aad'
    await expect(
      decryptTypedCredential({
        ...base,
        providerId: forgedProviderId,
        encryptedSecret,
      }),
    ).rejects.toThrow(/authentication failed/)
  })

  test('keyVersion is honoured on decrypt', async () => {
    const base = {
      providerId: 'p1',
      accountId: 'a1',
      authType: 'apiKey' as const,
      secretType: 'apiKey' as const,
      secretId: '11111111-1111-4111-8111-111111111111',
      value: { type: 'apiKey' as const, apiKey: 'k' },
      revision: 1,
    }
    const { encryptedSecret } = await encryptTypedCredential({
      ...base,
      keyVersion: 1,
    })
    await expect(
      decryptTypedCredential({ ...base, keyVersion: 2, encryptedSecret }),
    ).rejects.toThrow(/authentication failed/)
  })
})
