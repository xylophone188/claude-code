import { beforeEach, describe, expect, test } from 'bun:test'
import type { PoolClient } from 'pg'
import {
  assertNoPlaintextLeak,
  deterministicSecretId,
  importResourcePlaneBundle,
  transformProvidersJson,
  type ProviderJsonEntry,
} from '../importer.js'
import { decryptTypedCredential } from '../credentials.js'
import {
  validateResourceAuthSecretPair,
  ResourcePlaneValidationError,
} from '../types.js'

const TEST_KEY = 'test-resource-plane-key-material-for-importer'
const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function createMockPoolClient(): {
  tx: PoolClient
  accounts: Map<string, any>
  capabilities: Map<string, any>
  secrets: Map<string, any>
} {
  const accounts = new Map<string, any>()
  const capabilities = new Map<string, any>()
  const secrets = new Map<string, any>()

  const tx: any = {
    query: async (sql: string, params: any[] = []) => {
      // 1. Account metadata
      if (sql.includes('INSERT INTO resource_plane.provider_accounts')) {
        const [
          providerId,
          accountId,
          name,
          authType,
          transport,
          baseUrl,
          ownerNodeId,
          enabled,
          metadata,
          revision,
        ] = params
        const key = `${providerId}:${accountId}`
        const record = {
          providerId,
          accountId,
          name,
          authType,
          transport,
          baseUrl,
          ownerNodeId,
          enabled,
          metadata:
            typeof metadata === 'string' ? JSON.parse(metadata) : metadata,
          revision: Number(revision),
          updatedAt: new Date(),
        }
        accounts.set(key, record)
        return { rows: [record], rowCount: 1 }
      }

      // 2. Model capabilities
      if (sql.includes('INSERT INTO resource_plane.model_capabilities')) {
        const [providerId, modelId, capabilitiesData, limits, revision] = params
        const key = `${providerId}:${modelId}`
        const record = {
          providerId,
          modelId,
          capabilities:
            typeof capabilitiesData === 'string'
              ? JSON.parse(capabilitiesData)
              : capabilitiesData,
          limits: typeof limits === 'string' ? JSON.parse(limits) : limits,
          revision: Number(revision),
          updatedAt: new Date(),
        }
        capabilities.set(key, record)
        return { rows: [record], rowCount: 1 }
      }

      // 3. Credential secrets
      if (sql.includes('INSERT INTO resource_plane.credential_secrets')) {
        const [
          providerId,
          accountId,
          secretType,
          authType,
          secretId,
          keyVersion,
          encryptedSecret,
          expiresAt,
          refreshable,
          metadata,
          revision,
          ownerNodeId,
        ] = params
        const key = `${providerId}:${accountId}:${secretType}:${secretId}`
        const record = {
          providerId,
          accountId,
          secretType,
          authType,
          secretId,
          keyVersion: Number(keyVersion),
          encryptedSecret,
          expiresAt,
          refreshable: Boolean(refreshable),
          metadata:
            typeof metadata === 'string' ? JSON.parse(metadata) : metadata,
          revision: Number(revision),
          ownerNodeId,
          updatedAt: new Date(),
        }
        secrets.set(key, record)
        return { rows: [record], rowCount: 1 }
      }

      return { rows: [], rowCount: 0 }
    },
  }

  return { tx: tx as PoolClient, accounts, capabilities, secrets }
}

describe('Resource Plane Phase 2: Importer', () => {
  beforeEach(() => {
    process.env['CCB_RESOURCE_PLANE_KEY'] = TEST_KEY
  })

  describe('1. deterministicSecretId', () => {
    test('produces valid UUID format matching RFC 4122', () => {
      const id = deterministicSecretId(
        'resource_plane:secret',
        'gitee',
        'default',
        'apiKey',
      )
      expect(id).toMatch(UUID_REGEX)
      expect(id.length).toBe(36)
      // Check version 5
      expect(id[14]).toBe('5')
      // Check variant 1 (8, 9, a, or b)
      expect(['8', '9', 'a', 'b']).toContain(id[19]!.toLowerCase())
    })

    test('is pure and idempotent without randomUUID', () => {
      const id1 = deterministicSecretId(
        'resource_plane:secret',
        'nvidia',
        'key-1',
        'apiKey',
      )
      const id2 = deterministicSecretId(
        'resource_plane:secret',
        'nvidia',
        'key-1',
        'apiKey',
      )
      const id3 = deterministicSecretId(
        'resource_plane:secret',
        'nvidia',
        'key-1',
        'apiKey',
      )
      expect(id1).toBe(id2)
      expect(id2).toBe(id3)
    })

    test('different inputs produce distinct IDs', () => {
      const idA = deterministicSecretId(
        'resource_plane:secret',
        'p1',
        'acc1',
        'apiKey',
      )
      const idB = deterministicSecretId(
        'resource_plane:secret',
        'p1',
        'acc1',
        'accessToken',
      )
      const idC = deterministicSecretId(
        'resource_plane:secret',
        'p2',
        'acc1',
        'apiKey',
      )
      expect(idA).not.toBe(idB)
      expect(idA).not.toBe(idC)
      expect(idB).not.toBe(idC)
    })
  })

  describe('2. providers.json fixture import', () => {
    const fixture: ProviderJsonEntry[] = [
      {
        id: 'gitee',
        kind: 'openai-compat',
        baseUrl: 'https://ai.gitee.com/v1',
        apiKey: 'sk-gitee-secret-live-12345',
        defaultModel: 'GLM-4.7-Flash',
        models: ['GLM-4.7-Flash'],
        reasoningEffortMax: 100,
      },
      {
        id: 'nvidia',
        kind: 'openai-compat',
        baseUrl: 'https://integrate.api.nvidia.com/v1',
        defaultModel: 'meta/llama-3.3-70b-instruct',
        models: ['meta/llama-3.3-70b-instruct', 'deepseek-ai/deepseek-r1'],
        accounts: [
          {
            id: 'nv-key-1',
            name: 'Nvidia Primary',
            apiKey: 'nvapi-secret-key-alpha-999',
            model: 'meta/llama-3.3-70b-instruct',
          },
          {
            id: 'nv-key-2',
            name: 'Nvidia Backup',
            apiKey: 'nvapi-secret-key-beta-888',
            model: 'deepseek-ai/deepseek-r1',
          },
        ],
        reasoningEffortMax: 64,
      },
      {
        id: 'codebuddy-cn',
        kind: 'openai-compat',
        baseUrl: 'https://api.codebuddy.cn/v1',
        apiKeyEnv: 'CODEBUDDY_API_KEY',
        defaultModel: 'codebuddy-v1',
        compatRule: 'strict-json',
      },
      {
        id: 'chatgpt-codex',
        kind: 'chatgpt-oauth',
        baseUrl: 'https://api.openai.com/v1',
        defaultModel: 'gpt-4o',
        accounts: [
          {
            id: 'oauth-user-1',
            tokens: {
              access_token: 'ey-oauth-access-token-sample-11111',
              refresh_token: 'rt-oauth-refresh-token-sample-22222',
              id_token: 'id-oauth-id-token-sample-33333',
              account_id: 'b1f96782-1715-4fa2-bcde-0123456789ab',
            },
          },
        ],
      },
    ]

    test('transforms full fixture into valid ResourcePlaneImportBundle', () => {
      const bundle = transformProvidersJson(fixture, {
        ownerNodeId: 'pc-primary',
      })

      // Accounts: gitee (1), nvidia (2), codebuddy-cn (1), chatgpt-codex (1) = 5
      expect(bundle.accounts.length).toBe(5)
      expect(
        bundle.accounts.map(a => `${a.providerId}:${a.accountId}`),
      ).toEqual([
        'gitee:default',
        'nvidia:nv-key-1',
        'nvidia:nv-key-2',
        'codebuddy-cn:default',
        'chatgpt-codex:oauth-user-1',
      ])

      // Credentials:
      // gitee: default (apiKey)
      // nvidia: nv-key-1 (apiKey), nv-key-2 (apiKey)
      // codebuddy-cn: has apiKeyEnv only, no raw secret
      // chatgpt-codex: accessToken, refreshToken
      // Total credentials = 1 + 2 + 0 + 2 = 5
      expect(bundle.credentials.length).toBe(5)

      // Capabilities:
      // gitee: GLM-4.7-Flash
      // nvidia: meta/llama-3.3-70b-instruct, deepseek-ai/deepseek-r1
      // codebuddy-cn: codebuddy-v1
      // chatgpt-codex: gpt-4o
      expect(bundle.capabilities.length).toBe(5)
    })

    test('preserves extra metadata without secrets', () => {
      const bundle = transformProvidersJson(fixture)
      const giteeAcc = bundle.accounts.find(a => a.providerId === 'gitee')!
      expect(giteeAcc.metadata?.reasoningEffortMax).toBe(100)

      const cbAcc = bundle.accounts.find(a => a.providerId === 'codebuddy-cn')!
      expect(cbAcc.metadata?.apiKeyEnv).toBe('CODEBUDDY_API_KEY')
      expect(cbAcc.metadata?.compatRule).toBe('strict-json')
    })
  })

  describe('3. OAuth token secretType preservation & rejection of apiKey conversion', () => {
    test('strictly assigns secretType accessToken and refreshToken, NEVER apiKey', () => {
      const oauthEntry: ProviderJsonEntry = {
        id: 'codex-oauth',
        kind: 'chatgpt-oauth',
        accounts: [
          {
            id: 'acc-main',
            tokens: {
              access_token: 'live-access-token-000000',
              refresh_token: 'live-refresh-token-111111',
            },
          },
        ],
      }

      const bundle = transformProvidersJson([oauthEntry])
      expect(bundle.credentials.length).toBe(2)

      const accessCred = bundle.credentials.find(
        c => c.secretType === 'accessToken',
      )!
      expect(accessCred).toBeDefined()
      expect(accessCred.authType).toBe('oauth')
      expect(accessCred.secretType).toBe('accessToken')
      expect(accessCred.value.type).toBe('oauth')

      const refreshCred = bundle.credentials.find(
        c => c.secretType === 'refreshToken',
      )!
      expect(refreshCred).toBeDefined()
      expect(refreshCred.authType).toBe('oauth')
      expect(refreshCred.secretType).toBe('refreshToken')
      expect(refreshCred.value.type).toBe('oauth')

      // Assert none of the credentials was mapped to apiKey
      const anyApiKey = bundle.credentials.some(c => c.secretType === 'apiKey')
      expect(anyApiKey).toBe(false)
    })

    test('validateResourceAuthSecretPair rejects pairing OAuth with apiKey', () => {
      expect(() => {
        validateResourceAuthSecretPair('oauth', 'apiKey' as any)
      }).toThrow(ResourcePlaneValidationError)
    })
  })

  describe('4. secret encryption boundary (rpenc:v1)', () => {
    test('all written credentials in DB have rpenc:v1 envelope and can be decrypted', async () => {
      const { tx, secrets } = createMockPoolClient()
      const bundle = transformProvidersJson([
        {
          id: 'test-prov',
          apiKey: 'sk-super-secret-boundary-check-value-777',
        },
      ])

      const result = await importResourcePlaneBundle(tx, bundle)
      expect(result.credentialsCount).toBe(1)
      expect(secrets.size).toBe(1)

      const stored = Array.from(secrets.values())[0]
      expect(stored.encryptedSecret).toMatch(
        /^rpenc:v1:1:aes-256-gcm:[0-9a-f]{24}:[0-9a-f]+:[0-9a-f]{32}$/,
      )

      // Verify decrypts back cleanly
      const decrypted = await decryptTypedCredential(stored)
      expect(decrypted.type).toBe('apiKey')
      if (decrypted.type === 'apiKey') {
        expect(decrypted.apiKey).toBe(
          'sk-super-secret-boundary-check-value-777',
        )
      }
    })
  })

  describe('5. plaintext leak detection', () => {
    const rawPlaintextKey = 'sk-extremely-sensitive-raw-api-key-998877'
    const rawAccessToken = 'ey-sensitive-bearer-token-445566'

    test('assertNoPlaintextLeak detects leak if present', () => {
      const leakyObject = {
        name: 'test',
        metadata: {
          note: `using key ${rawPlaintextKey}`,
        },
      }
      expect(() => {
        assertNoPlaintextLeak(leakyObject, [rawPlaintextKey])
      }).toThrow(/Plaintext secret leak detected/)
    })

    test('no plaintext leak in account metadata or model capabilities', async () => {
      const { tx, accounts, capabilities, secrets } = createMockPoolClient()
      const bundle = transformProvidersJson([
        {
          id: 'leak-check-provider',
          apiKey: rawPlaintextKey,
          defaultModel: 'test-model',
          accounts: [
            {
              id: 'oauth-acc',
              tokens: {
                access_token: rawAccessToken,
              },
            },
          ],
        },
      ])

      await importResourcePlaneBundle(tx, bundle)

      const forbiddenPlaintexts = [rawPlaintextKey, rawAccessToken]

      // 1. Check generated bundle accounts and capabilities
      expect(() =>
        assertNoPlaintextLeak(bundle.accounts, forbiddenPlaintexts),
      ).not.toThrow()
      expect(() =>
        assertNoPlaintextLeak(bundle.capabilities, forbiddenPlaintexts),
      ).not.toThrow()

      // 2. Check DB stored accounts and capabilities
      const storedAccounts = Array.from(accounts.values())
      const storedCapabilities = Array.from(capabilities.values())
      expect(() =>
        assertNoPlaintextLeak(storedAccounts, forbiddenPlaintexts),
      ).not.toThrow()
      expect(() =>
        assertNoPlaintextLeak(storedCapabilities, forbiddenPlaintexts),
      ).not.toThrow()

      // 3. Check DB stored secrets metadata
      for (const secret of secrets.values()) {
        expect(secret.encryptedSecret).not.toContain(rawPlaintextKey)
        expect(secret.encryptedSecret).not.toContain(rawAccessToken)
        expect(() =>
          assertNoPlaintextLeak(secret.metadata, forbiddenPlaintexts),
        ).not.toThrow()
      }
    })
  })

  describe('6. duplicate import idempotency', () => {
    test('repeating import on identical input results in identical secretIds and zero duplicates', async () => {
      const { tx, accounts, capabilities, secrets } = createMockPoolClient()
      const fixture: ProviderJsonEntry[] = [
        {
          id: 'idempotent-provider',
          apiKey: 'sk-idempotent-test-key-555',
          defaultModel: 'model-a',
          models: ['model-a', 'model-b'],
        },
      ]

      // First run
      const bundle1 = transformProvidersJson(fixture)
      const res1 = await importResourcePlaneBundle(tx, bundle1)
      expect(res1.accountsCount).toBe(1)
      expect(res1.credentialsCount).toBe(1)
      expect(res1.capabilitiesCount).toBe(2)
      expect(accounts.size).toBe(1)
      expect(capabilities.size).toBe(2)
      expect(secrets.size).toBe(1)

      const secretIdFirstRun = res1.secretIds[0]

      // Second run with identical fixture
      const bundle2 = transformProvidersJson(fixture)
      const res2 = await importResourcePlaneBundle(tx, bundle2)
      expect(res2.accountsCount).toBe(1)
      expect(res2.credentialsCount).toBe(1)
      expect(res2.capabilitiesCount).toBe(2)

      // Identical deterministic secretId
      expect(res2.secretIds[0]).toBe(secretIdFirstRun)

      // Map sizes did not grow (zero duplicate rows)
      expect(accounts.size).toBe(1)
      expect(capabilities.size).toBe(2)
      expect(secrets.size).toBe(1)
    })
  })
})
