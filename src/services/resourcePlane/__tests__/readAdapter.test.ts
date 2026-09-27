import { describe, expect, test, beforeEach } from 'bun:test'
import {
  loadProvidersFromResourcePlane,
  resolveTransportCredential,
  invalidateResourcePlaneCache,
} from '../readAdapter.js'
import { encryptTypedCredential } from '../credentials.js'

describe('Resource Plane Read Adapter (Phase 3.1)', () => {
  beforeEach(() => {
    process.env['CCB_RESOURCE_PLANE_KEY'] = 'test-resource-plane-key-material-32'
    invalidateResourcePlaneCache()
  })

  test('reads provider metadata without decrypting credentials (zero credential leak in routing)', async () => {
    const mockAccounts = [
      {
        provider_id: 'gitee',
        account_id: 'default',
        name: 'Gitee Main',
        auth_type: 'apiKey',
        transport: 'openai-compat',
        base_url: 'https://ai.gitee.com/v1',
        owner_node_id: 'node-pc',
        enabled: true,
        metadata: { defaultModel: 'GLM-4.7-Flash', compatRule: 'permissive' },
        revision: 1,
        updated_at: new Date(),
      },
      {
        provider_id: 'nvidia',
        account_id: 'nv-1',
        name: 'Nvidia Primary',
        auth_type: 'apiKey',
        transport: 'openai-compat',
        base_url: 'https://integrate.api.nvidia.com/v1',
        owner_node_id: 'node-pc',
        enabled: true,
        metadata: { model: 'meta/llama-3.3-70b-instruct' },
        revision: 1,
        updated_at: new Date(),
      },
    ]

    const mockCapabilities = [
      {
        provider_id: 'gitee',
        model_id: 'GLM-4.7-Flash',
        capabilities: { supportsStreaming: true },
        limits: {},
      },
      {
        provider_id: 'nvidia',
        model_id: 'meta/llama-3.3-70b-instruct',
        capabilities: { supportsStreaming: true },
        limits: {},
      },
    ]

    const mockClient: any = {
      query: async (sql: string) => {
        if (sql.includes('FROM resource_plane.provider_accounts')) {
          return { rows: mockAccounts }
        }
        if (sql.includes('FROM resource_plane.model_capabilities')) {
          return { rows: mockCapabilities }
        }
        return { rows: [] }
      },
    }

    const providers = await loadProvidersFromResourcePlane({ pool: mockClient })

    expect(providers.length).toBe(2)
    const gitee = providers.find(p => p.id === 'gitee')!
    expect(gitee).toBeDefined()
    expect(gitee.baseUrl).toBe('https://ai.gitee.com/v1')
    expect(gitee.defaultModel).toBe('GLM-4.7-Flash')
    expect(gitee.models).toEqual(['GLM-4.7-Flash'])
    expect(gitee.accounts).toBeDefined()
    expect(gitee.accounts![0].id).toBe('default')
    // METADATA ONLY: apiKey must NOT be present
    expect(gitee.accounts![0].apiKey).toBeUndefined()

    const nvidia = providers.find(p => p.id === 'nvidia')!
    expect(nvidia).toBeDefined()
    expect(nvidia.accounts![0].id).toBe('nv-1')
    expect(nvidia.accounts![0].model).toBe('meta/llama-3.3-70b-instruct')
    expect(nvidia.accounts![0].apiKey).toBeUndefined()
  })

  test('decrypts credentials when explicitly opted in (decryptCredentials: true)', async () => {
    const encrypted = await encryptTypedCredential({
      providerId: 'gitee',
      accountId: 'default',
      authType: 'apiKey',
      secretType: 'apiKey',
      secretId: '00000000-0000-5000-a000-000000000001',
      value: { type: 'apiKey', apiKey: 'sk-gitee-unsealed-test-key' },
      revision: 1,
    })

    const mockAccounts = [
      {
        provider_id: 'gitee',
        account_id: 'default',
        auth_type: 'apiKey',
        transport: 'openai-compat',
        base_url: 'https://ai.gitee.com/v1',
        enabled: true,
        metadata: { defaultModel: 'GLM-4.7-Flash' },
      },
    ]

    const mockSecrets = [
      {
        provider_id: 'gitee',
        account_id: 'default',
        secret_type: 'apiKey',
        auth_type: 'apiKey',
        secret_id: '00000000-0000-5000-a000-000000000001',
        key_version: 1,
        encrypted_secret: encrypted.encryptedSecret,
        revision: 1,
      },
    ]

    const mockClient: any = {
      query: async (sql: string) => {
        if (sql.includes('FROM resource_plane.provider_accounts')) {
          return { rows: mockAccounts }
        }
        if (sql.includes('FROM resource_plane.model_capabilities')) {
          return { rows: [] }
        }
        if (sql.includes('FROM resource_plane.credential_secrets')) {
          return { rows: mockSecrets }
        }
        return { rows: [] }
      },
    }

    const providers = await loadProvidersFromResourcePlane({
      pool: mockClient,
      decryptCredentials: true,
    })

    expect(providers.length).toBe(1)
    expect(providers[0].accounts![0].apiKey).toBe('sk-gitee-unsealed-test-key')
  })

  test('resolveTransportCredential resolves single credential at network boundary', async () => {
    const encrypted = await encryptTypedCredential({
      providerId: 'codex',
      accountId: 'acc-work',
      authType: 'oauth',
      secretType: 'accessToken',
      secretId: '00000000-0000-5000-a000-000000000002',
      value: {
        type: 'oauth',
        accessToken: 'ey-oauth-transport-token-999',
      },
      revision: 1,
    })

    const mockClient: any = {
      query: async (sql: string, params: any[]) => {
        if (params[0] === 'codex' && params[1] === 'acc-work') {
          return {
            rows: [
              {
                provider_id: 'codex',
                account_id: 'acc-work',
                secret_type: 'accessToken',
                auth_type: 'oauth',
                secret_id: '00000000-0000-5000-a000-000000000002',
                key_version: 1,
                encrypted_secret: encrypted.encryptedSecret,
                revision: 1,
              },
            ],
          }
        }
        return { rows: [] }
      },
    }

    const token = await resolveTransportCredential('codex', 'acc-work', 'accessToken', mockClient)
    expect(token).toBe('ey-oauth-transport-token-999')

    const notFound = await resolveTransportCredential('non-existent', 'default', undefined, mockClient)
    expect(notFound).toBeUndefined()
  })

  test('degrades gracefully to empty array when database throws', async () => {
    const failingClient: any = {
      query: async () => {
        throw new Error('Connection refused')
      },
    }

    const providers = await loadProvidersFromResourcePlane({ pool: failingClient })
    expect(providers).toEqual([])
  })
})
