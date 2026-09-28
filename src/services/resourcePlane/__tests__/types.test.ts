import { describe, expect, test } from 'bun:test'
import {
  credentialSecretToStoredValue,
  isResourceAuthType,
  isResourceSecretType,
  redactCredentialRecord,
  ResourcePlaneValidationError,
  storedValueToCredentialSecret,
  validateResourceAuthSecretPair,
  type ResourceSecretType,
  type TypedCredentialRecord,
} from '../types.js'

describe('authType/secretType validation', () => {
  test('accepts apiKey pair', () => {
    expect(() =>
      validateResourceAuthSecretPair('apiKey', 'apiKey'),
    ).not.toThrow()
  })

  test('rejects apiKey authType with any non-apiKey secretType', () => {
    expect(() =>
      validateResourceAuthSecretPair('apiKey', 'accessToken'),
    ).toThrow(ResourcePlaneValidationError)
  })

  test('rejects OAuth credentials being folded into apiKey secretType', () => {
    expect(() => validateResourceAuthSecretPair('oauth', 'apiKey')).toThrow(
      /OAuth authType must not use apiKey secretType/,
    )
  })

  test('accepts each OAuth secretType', () => {
    for (const secretType of [
      'accessToken',
      'refreshToken',
      'idToken',
      'clientSecret',
    ] as ResourceSecretType[]) {
      expect(() =>
        validateResourceAuthSecretPair('oauth', secretType),
      ).not.toThrow()
    }
  })

  test('rejects OAuth certificate/password/custom secretType', () => {
    for (const secretType of [
      'certificate',
      'password',
      'custom',
    ] as ResourceSecretType[]) {
      expect(() => validateResourceAuthSecretPair('oauth', secretType)).toThrow(
        ResourcePlaneValidationError,
      )
    }
  })

  test('enforces one-to-one pairs for mtls, basic, custom', () => {
    expect(() =>
      validateResourceAuthSecretPair('mtls', 'certificate'),
    ).not.toThrow()
    expect(() => validateResourceAuthSecretPair('mtls', 'password')).toThrow()
    expect(() =>
      validateResourceAuthSecretPair('basic', 'password'),
    ).not.toThrow()
    expect(() =>
      validateResourceAuthSecretPair('basic', 'certificate'),
    ).toThrow()
    expect(() =>
      validateResourceAuthSecretPair('custom', 'custom'),
    ).not.toThrow()
    expect(() => validateResourceAuthSecretPair('custom', 'apiKey')).toThrow()
  })
})

describe('credential value (de)serialization', () => {
  test('round-trips apiKey', () => {
    const stored = credentialSecretToStoredValue({
      type: 'apiKey',
      apiKey: 'sk-live-1',
    })
    expect(stored).toEqual({ apiKey: 'sk-live-1' })
    expect(storedValueToCredentialSecret('apiKey', 'apiKey', stored)).toEqual({
      type: 'apiKey',
      apiKey: 'sk-live-1',
    })
  })

  test('round-trips oauth token set and drops empty optional fields', () => {
    const stored = credentialSecretToStoredValue({
      type: 'oauth',
      accessToken: 'a',
      refreshToken: 'r',
      clientSecret: 'c',
    })
    expect(stored).toEqual({
      accessToken: 'a',
      refreshToken: 'r',
      clientSecret: 'c',
    })
    expect('idToken' in stored).toBe(false)
    const back = storedValueToCredentialSecret('oauth', 'accessToken', stored)
    expect(back).toEqual({
      type: 'oauth',
      accessToken: 'a',
      refreshToken: 'r',
      clientSecret: 'c',
    })
  })

  test('round-trips custom secrets', () => {
    const stored = credentialSecretToStoredValue({
      type: 'custom',
      secrets: { username: 'u', token: 't' },
    })
    expect(stored).toEqual({ username: 'u', token: 't' })
    expect(storedValueToCredentialSecret('custom', 'custom', stored)).toEqual({
      type: 'custom',
      secrets: { username: 'u', token: 't' },
    })
  })

  test('rejects empty custom secret map', () => {
    expect(() =>
      credentialSecretToStoredValue({ type: 'custom', secrets: {} }),
    ).toThrow(/must contain at least one secret/)
  })

  test('rejects empty required apiKey', () => {
    expect(() =>
      credentialSecretToStoredValue({ type: 'apiKey', apiKey: '' }),
    ).toThrow(/must be a non-empty string/)
  })

  test('rejects empty oauth accessToken', () => {
    expect(() =>
      credentialSecretToStoredValue({ type: 'oauth', accessToken: '' }),
    ).toThrow(/must be a non-empty string/)
  })
})

describe('redaction', () => {
  test('removes encryptedSecret and keeps safe metadata', () => {
    const record: TypedCredentialRecord = {
      providerId: 'openai',
      accountId: 'acct-1',
      authType: 'oauth',
      secretType: 'accessToken',
      secretId: '11111111-1111-4111-8111-111111111111',
      keyVersion: 1,
      encryptedSecret: 'rpenc:v1:1:aes-256-gcm:aaaa:bbbb:cccc',
      refreshable: true,
      metadata: { scope: 'chat' },
      revision: 3,
      updatedAt: new Date('2026-09-27T00:00:00Z'),
    }
    const redacted = redactCredentialRecord(record)
    expect('encryptedSecret' in redacted).toBe(false)
    expect(JSON.stringify(redacted)).not.toContain('rpenc:')
    expect(redacted.secretId).toBe(record.secretId)
    expect(redacted.metadata).toEqual({ scope: 'chat' })
  })
})

describe('type guards', () => {
  test('accept only declared values', () => {
    expect(isResourceAuthType('apiKey')).toBe(true)
    expect(isResourceAuthType('none')).toBe(false)
    expect(isResourceSecretType('refreshToken')).toBe(true)
    expect(isResourceSecretType(42)).toBe(false)
  })
})
