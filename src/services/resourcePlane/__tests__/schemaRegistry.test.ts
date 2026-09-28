import { beforeEach, describe, expect, test } from 'bun:test'
import {
  CredentialSchemaRegistry,
  resetSchemaRegistryForTest,
} from '../schemaRegistry.js'
import { runResourcePlaneMigrations } from '../migrations.js'

describe('Phase 5.0: Schema Registry', () => {
  beforeEach(async () => {
    resetSchemaRegistryForTest()
    await runResourcePlaneMigrations()
  })

  test('registerSchema inserts a new schema', async () => {
    const schema = await CredentialSchemaRegistry.registerSchema({
      providerId: 'acme',
      authType: 'apiKey',
      secretType: 'userKey',
      schemaJson: {
        type: 'object',
        required: ['key'],
        properties: { key: { type: 'string', pattern: '^sk-' } },
      },
    })

    expect(schema.schemaId).toBeDefined()
    expect(schema.version).toBe(1)
    expect(schema.providerId).toBe('acme')
    expect(schema.createdAt instanceof Date).toBe(true)
  })

  test('registerSchema with same key updates schema_json and keeps version', async () => {
    const first = await CredentialSchemaRegistry.registerSchema({
      providerId: 'acme',
      authType: 'apiKey',
      secretType: 'userKey',
      schemaJson: { type: 'object', required: ['old'], properties: {} },
    })

    const second = await CredentialSchemaRegistry.registerSchema({
      providerId: 'acme',
      authType: 'apiKey',
      secretType: 'userKey',
      schemaJson: { type: 'object', required: ['new'], properties: {} },
    })

    expect(second.version).toBe(first.version)
    expect(second.schemaId).toBe(first.schemaId)
    // latest should reflect the updated shape
    const latest = await CredentialSchemaRegistry.getLatestSchema(
      'acme',
      'apiKey',
      'userKey',
    )
    expect(latest).not.toBeNull()
    expect(latest!.schemaJson.required).toEqual(['new'])
  })

  test('getSchema returns null for unknown shape', async () => {
    const result = await CredentialSchemaRegistry.getSchema(
      'nope',
      'oauth',
      'jwt',
      1,
    )
    expect(result).toBeNull()
  })

  test('validate rejects missing required string field', async () => {
    await CredentialSchemaRegistry.registerSchema({
      providerId: 'acme',
      authType: 'apiKey',
      secretType: 'userKey',
      schemaJson: {
        type: 'object',
        required: ['key'],
        properties: { key: { type: 'string' } },
      },
    })

    const result = await CredentialSchemaRegistry.validate({
      providerId: 'acme',
      authType: 'apiKey',
      secretType: 'userKey',
      credentialData: {},
    })
    expect(result.registered).toBe(true)
    expect(result.valid).toBe(false)
    expect(
      result.violations.some(v => v.includes('required field missing')),
    ).toBe(true)
  })

  test('validate accepts object with all required string fields', async () => {
    await CredentialSchemaRegistry.registerSchema({
      providerId: 'acme',
      authType: 'apiKey',
      secretType: 'userKey',
      schemaJson: {
        type: 'object',
        required: ['key'],
        properties: { key: { type: 'string' } },
      },
    })

    const result = await CredentialSchemaRegistry.validate({
      providerId: 'acme',
      authType: 'apiKey',
      secretType: 'userKey',
      credentialData: { key: 'sk-abc' },
    })
    expect(result.valid).toBe(true)
    expect(result.violations).toEqual([])
  })

  test('validate enforces pattern on string field', async () => {
    await CredentialSchemaRegistry.registerSchema({
      providerId: 'acme',
      authType: 'apiKey',
      secretType: 'userKey',
      schemaJson: {
        type: 'object',
        required: ['key'],
        properties: { key: { type: 'string', pattern: '^sk-' } },
      },
    })

    const result = await CredentialSchemaRegistry.validate({
      providerId: 'acme',
      authType: 'apiKey',
      secretType: 'userKey',
      credentialData: { key: 'bad-key' },
    })
    expect(result.valid).toBe(false)
    expect(result.violations.some(v => v.includes('pattern'))).toBe(true)
  })

  test('validate allows empty violations for unregistered shapes', async () => {
    const result = await CredentialSchemaRegistry.validate({
      providerId: 'unknown-provider',
      authType: 'apiKey',
      secretType: 'userKey',
      credentialData: { any: 'field' },
    })
    expect(result.valid).toBe(true)
    expect(result.registered).toBe(false)
    expect(result.violations).toEqual([])
  })

  test('listSchemas returns registered schemas', async () => {
    await CredentialSchemaRegistry.registerSchema({
      providerId: 'acme',
      authType: 'apiKey',
      secretType: 'userKey',
      schemaJson: {
        type: 'object',
        required: ['k'],
        properties: { k: { type: 'string' } },
      },
    })

    const schemas = await CredentialSchemaRegistry.listSchemas()
    expect(schemas.length).toBeGreaterThan(0)
    const acme = schemas.find(s => s.providerId === 'acme')
    expect(acme).not.toBeNull()
    expect(acme!.schemaJson.type).toBe('object')
  })

  test('deleteSchema removes the registered schema', async () => {
    await CredentialSchemaRegistry.registerSchema({
      providerId: 'acme',
      authType: 'apiKey',
      secretType: 'userKey',
      schemaJson: { type: 'object', required: ['k'], properties: {} },
    })

    const deleted = await CredentialSchemaRegistry.deleteSchema(
      'acme',
      'apiKey',
      'userKey',
      1,
    )
    expect(deleted).toBe(true)

    const result = await CredentialSchemaRegistry.getSchema(
      'acme',
      'apiKey',
      'userKey',
      1,
    )
    expect(result).toBeNull()
  })

  test('deleteSchema returns false when schema not found', async () => {
    const deleted = await CredentialSchemaRegistry.deleteSchema(
      'nope',
      'jwt',
      'secret',
      99,
    )
    expect(deleted).toBe(false)
  })
})
