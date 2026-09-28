import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { Client, Pool } from 'pg'
import {
  assertNoPlaintextLeak,
  importResourcePlaneBundle,
  transformProvidersJson,
  type ProviderJsonEntry,
} from '../importer.js'
import { runResourcePlaneMigrations } from '../migrations.js'
import { decryptTypedCredential } from '../credentials.js'

const TEST_KEY = 'test-resource-plane-key-material-for-pg-gate'
const TEST_DB = 'rp_gate_temp_test'
const PG_PORT = 5432
const PG_USER = 'omniroute'
const PG_HOST = '127.0.0.1'

let pool: Pool
let isIsolatedDb = false

beforeAll(async () => {
  process.env['CCB_RESOURCE_PLANE_KEY'] = TEST_KEY

  // Try creating an isolated database
  const adminClient = new Client({
    host: PG_HOST,
    port: PG_PORT,
    user: PG_USER,
    database: 'omniroute',
  })
  await adminClient.connect()

  try {
    await adminClient.query(`DROP DATABASE IF EXISTS ${TEST_DB}`)
    await adminClient.query(`CREATE DATABASE ${TEST_DB}`)
    isIsolatedDb = true
    console.log(`[PG GATE] Created isolated database: ${TEST_DB}`)
  } catch (err: any) {
    console.log(
      `[PG GATE] Isolated DB creation skipped (${err.message}), using omniroute database`,
    )
    isIsolatedDb = false
  } finally {
    await adminClient.end()
  }

  // Connect to the target DB
  const targetDb = isIsolatedDb ? TEST_DB : 'omniroute'
  pool = new Pool({
    host: PG_HOST,
    port: PG_PORT,
    user: PG_USER,
    database: targetDb,
  })

  if (!isIsolatedDb) {
    const client = await pool.connect()
    try {
      await client.query('DROP SCHEMA IF EXISTS resource_plane CASCADE')
    } finally {
      client.release()
    }
  }
})

afterAll(async () => {
  if (pool) {
    await pool.end()
  }

  if (isIsolatedDb) {
    const adminClient = new Client({
      host: PG_HOST,
      port: PG_PORT,
      user: PG_USER,
      database: 'omniroute',
    })
    try {
      await adminClient.connect()
      await adminClient.query(`DROP DATABASE IF EXISTS ${TEST_DB}`)
      console.log(`[PG GATE] Cleaned up isolated database: ${TEST_DB}`)
    } catch (e: any) {
      console.error(`[PG GATE] Cleanup error:`, e.message)
    } finally {
      await adminClient.end()
    }
  }
})

describe('Phase 2.5 PG Validation Gate', () => {
  test('1. applyResourcePlaneMigrations executes and is idempotent', async () => {
    // Run 1: clean run
    const result1 = await runResourcePlaneMigrations(pool)
    expect(result1.applied).toContain(1)
    expect(result1.failed).toBeUndefined()

    // Run 2: idempotent re-run
    const result2 = await runResourcePlaneMigrations(pool)
    expect(result2.applied.length).toBe(0)
    expect(result2.skipped).toContain(1)
  })

  test('2. Schema, tables, primary keys, and indexes exist in real PG', async () => {
    const client = await pool.connect()
    try {
      // 2.1 Check schema
      const schemaRes = await client.query(
        `SELECT schema_name FROM information_schema.schemata WHERE schema_name = 'resource_plane'`,
      )
      expect(schemaRes.rows.length).toBe(1)

      // 2.2 Check tables
      const tablesRes = await client.query(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = 'resource_plane'`,
      )
      const tableNames = tablesRes.rows.map(r => r.table_name)
      expect(tableNames).toContain('provider_accounts')
      expect(tableNames).toContain('credential_secrets')
      expect(tableNames).toContain('model_capabilities')
      expect(tableNames).toContain('provider_health')
      expect(tableNames).toContain('quota_state')
      expect(tableNames).toContain('routing_resources')
      expect(tableNames).toContain('device_resources')
      expect(tableNames).toContain('outbox_events')
      expect(tableNames).toContain('inbox_events')
      expect(tableNames).toContain('lease_state')
      expect(tableNames).toContain('audit_events')
      expect(tableNames).toContain('migrations')

      // 2.3 Check primary key on provider_accounts
      const pkAccountsRes = await client.query(`
        SELECT kcu.column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
          AND tc.table_schema = kcu.table_schema
        WHERE tc.table_schema = 'resource_plane'
          AND tc.table_name = 'provider_accounts'
          AND tc.constraint_type = 'PRIMARY KEY'
        ORDER BY kcu.ordinal_position
      `)
      expect(pkAccountsRes.rows.map(r => r.column_name)).toEqual([
        'provider_id',
        'account_id',
      ])

      // 2.4 Check primary key on credential_secrets
      const pkSecretsRes = await client.query(`
        SELECT kcu.column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name
          AND tc.table_schema = kcu.table_schema
        WHERE tc.table_schema = 'resource_plane'
          AND tc.table_name = 'credential_secrets'
          AND tc.constraint_type = 'PRIMARY KEY'
        ORDER BY kcu.ordinal_position
      `)
      expect(pkSecretsRes.rows.map(r => r.column_name)).toEqual([
        'provider_id',
        'account_id',
        'secret_type',
        'secret_id',
      ])

      // 2.5 Check indexes
      const idxRes = await client.query(`
        SELECT indexname FROM pg_indexes WHERE schemaname = 'resource_plane'
      `)
      const indexNames = idxRes.rows.map(r => r.indexname)
      expect(indexNames).toContain('idx_rp_provider_accounts_auth')
      expect(indexNames).toContain('idx_rp_credential_secrets_refreshable')
      expect(indexNames).toContain('idx_rp_credential_secrets_expiry')
    } finally {
      client.release()
    }
  })

  test('3. First import with fixture succeeds against real PG', async () => {
    const fixture: ProviderJsonEntry[] = [
      {
        id: 'gitee',
        kind: 'openai-compat',
        baseUrl: 'https://ai.gitee.com/v1',
        apiKey: 'sk-gitee-pg-fixture-key-001',
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
            id: 'nv-acc-1',
            name: 'Nvidia Primary',
            apiKey: 'nvapi-pg-fixture-key-alpha',
            model: 'meta/llama-3.3-70b-instruct',
          },
          {
            id: 'nv-acc-2',
            name: 'Nvidia Secondary',
            apiKey: 'nvapi-pg-fixture-key-beta',
            model: 'deepseek-ai/deepseek-r1',
          },
        ],
      },
      {
        id: 'openai-codex',
        kind: 'chatgpt-oauth',
        baseUrl: 'https://api.openai.com/v1',
        defaultModel: 'gpt-4o',
        accounts: [
          {
            id: 'codex-acc-1',
            tokens: {
              access_token: 'ey-oauth-access-token-pg-gate-111',
              refresh_token: 'rt-oauth-refresh-token-pg-gate-222',
              id_token: 'id-oauth-token-pg-gate-333',
            },
          },
        ],
      },
    ]

    const bundle = transformProvidersJson(fixture, { ownerNodeId: 'pc-gate' })
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const result = await importResourcePlaneBundle(client, bundle)
      await client.query('COMMIT')

      expect(result.accountsCount).toBe(4)
      expect(result.credentialsCount).toBe(5)
      expect(result.capabilitiesCount).toBe(4)

      const accRes = await client.query(
        'SELECT count(*)::int as c FROM resource_plane.provider_accounts',
      )
      expect(accRes.rows[0].c).toBe(4)

      const secRes = await client.query(
        'SELECT count(*)::int as c FROM resource_plane.credential_secrets',
      )
      expect(secRes.rows[0].c).toBe(5)

      const capRes = await client.query(
        'SELECT count(*)::int as c FROM resource_plane.model_capabilities',
      )
      expect(capRes.rows[0].c).toBe(4)
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally {
      client.release()
    }
  })

  test('4. Second duplicate import: identical secretId, zero duplicates in real PG', async () => {
    const fixture: ProviderJsonEntry[] = [
      {
        id: 'gitee',
        kind: 'openai-compat',
        baseUrl: 'https://ai.gitee.com/v1',
        apiKey: 'sk-gitee-pg-fixture-key-001',
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
            id: 'nv-acc-1',
            name: 'Nvidia Primary',
            apiKey: 'nvapi-pg-fixture-key-alpha',
            model: 'meta/llama-3.3-70b-instruct',
          },
          {
            id: 'nv-acc-2',
            name: 'Nvidia Secondary',
            apiKey: 'nvapi-pg-fixture-key-beta',
            model: 'deepseek-ai/deepseek-r1',
          },
        ],
      },
      {
        id: 'openai-codex',
        kind: 'chatgpt-oauth',
        baseUrl: 'https://api.openai.com/v1',
        defaultModel: 'gpt-4o',
        accounts: [
          {
            id: 'codex-acc-1',
            tokens: {
              access_token: 'ey-oauth-access-token-pg-gate-111',
              refresh_token: 'rt-oauth-refresh-token-pg-gate-222',
              id_token: 'id-oauth-token-pg-gate-333',
            },
          },
        ],
      },
    ]

    const bundle1 = transformProvidersJson(fixture, { ownerNodeId: 'pc-gate' })
    const bundle2 = transformProvidersJson(fixture, { ownerNodeId: 'pc-gate' })

    expect(bundle1.credentials.map(c => c.secretId)).toEqual(
      bundle2.credentials.map(c => c.secretId),
    )

    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      const result2 = await importResourcePlaneBundle(client, bundle2)
      await client.query('COMMIT')

      expect(result2.accountsCount).toBe(4)
      expect(result2.credentialsCount).toBe(5)

      // CRITICAL: DB row counts MUST NOT increase (idempotent ON CONFLICT)
      const accRes = await client.query(
        'SELECT count(*)::int as c FROM resource_plane.provider_accounts',
      )
      expect(accRes.rows[0].c).toBe(4)

      const secRes = await client.query(
        'SELECT count(*)::int as c FROM resource_plane.credential_secrets',
      )
      expect(secRes.rows[0].c).toBe(5)

      const capRes = await client.query(
        'SELECT count(*)::int as c FROM resource_plane.model_capabilities',
      )
      expect(capRes.rows[0].c).toBe(4)
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally {
      client.release()
    }
  })

  test('5. credential_secrets encrypted_secret has rpenc:v1:1:aes-256-gcm: prefix and zero plaintext leak', async () => {
    const client = await pool.connect()
    try {
      const res = await client.query(`
        SELECT provider_id, account_id, secret_type, auth_type, secret_id, encrypted_secret, metadata
        FROM resource_plane.credential_secrets
      `)
      expect(res.rows.length).toBe(5)

      const plaintexts = [
        'sk-gitee-pg-fixture-key-001',
        'nvapi-pg-fixture-key-alpha',
        'nvapi-pg-fixture-key-beta',
        'ey-oauth-access-token-pg-gate-111',
        'rt-oauth-refresh-token-pg-gate-222',
      ]

      for (const row of res.rows) {
        expect(row.encrypted_secret).toMatch(
          /^rpenc:v1:1:aes-256-gcm:[0-9a-f]{24}:[0-9a-f]+:[0-9a-f]{32}$/,
        )

        for (const pt of plaintexts) {
          expect(row.encrypted_secret).not.toContain(pt)
        }

        assertNoPlaintextLeak(row.metadata, plaintexts)

        const decrypted = await decryptTypedCredential({
          providerId: row.provider_id,
          accountId: row.account_id,
          authType: row.auth_type,
          secretType: row.secret_type,
          secretId: row.secret_id,
          encryptedSecret: row.encrypted_secret,
        })

        if (row.auth_type === 'apiKey') {
          expect(decrypted.type).toBe('apiKey')
          if (decrypted.type === 'apiKey') {
            expect(plaintexts).toContain(decrypted.apiKey)
          }
        } else if (row.auth_type === 'oauth') {
          expect(decrypted.type).toBe('oauth')
          if (decrypted.type === 'oauth') {
            expect(decrypted.accessToken).toBe(
              'ey-oauth-access-token-pg-gate-111',
            )
            if (row.secret_type === 'refreshToken') {
              expect(decrypted.refreshToken).toBe(
                'rt-oauth-refresh-token-pg-gate-222',
              )
            }
          }
        }
      }
    } finally {
      client.release()
    }
  })
})
