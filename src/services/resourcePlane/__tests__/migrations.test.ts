import { describe, expect, test } from 'bun:test'
import {
  RESOURCE_PLANE_MIGRATIONS,
  RESOURCE_PLANE_SCHEMA,
  rollbackLatestResourcePlaneMigration,
  runResourcePlaneMigrations,
} from '../migrations.js'

const PLAN_TABLES = [
  'provider_accounts',
  'model_capabilities',
  'provider_health',
  'quota_state',
  'routing_resources',
  'device_resources',
  'sync_metadata',
  'credential_secrets',
  'outbox_events',
  'inbox_events',
  'lease_state',
  'audit_events',
]

function v1Up(): string {
  const migration = RESOURCE_PLANE_MIGRATIONS.find(m => m.version === 1)
  if (!migration) throw new Error('migration 1 missing')
  return migration.up
}

describe('migration definitions', () => {
  test('versions are unique and ascending', () => {
    const versions = RESOURCE_PLANE_MIGRATIONS.map(m => m.version)
    expect(new Set(versions).size).toBe(versions.length)
    expect([...versions].sort((a, b) => a - b)).toEqual(versions)
  })

  test('v1 keeps every table inside the resource_plane schema', () => {
    const sql = v1Up().toLowerCase()
    const createTables = sql.match(/create table if not exists (\S+)/g) ?? []
    expect(createTables.length).toBeGreaterThanOrEqual(PLAN_TABLES.length)
    for (const create of createTables) {
      expect(create).toContain(`${RESOURCE_PLANE_SCHEMA}.`)
    }
  })

  test('v1 creates every planned table', () => {
    const sql = v1Up().toLowerCase()
    for (const table of PLAN_TABLES) {
      expect(sql).toContain(`${RESOURCE_PLANE_SCHEMA}.${table}`)
    }
  })

  test('the expiry guard migration hardens credential_secrets without dropping data', () => {
    const migration = RESOURCE_PLANE_MIGRATIONS.find(m => m.version === 2)
    expect(migration).toBeDefined()
    if (!migration) return
    const sql = migration.up.toLowerCase()
    expect(sql).toContain('check (')
    expect(sql).toContain('expires_at is null or expires_at > now()')
    expect(sql).toContain('not valid')
    expect(sql).toContain('expires_at nulls first')
    expect(sql).not.toContain('drop table')
    expect(sql).not.toContain('truncate')
    expect(migration.down).toBeDefined()
    expect(migration.down?.toLowerCase()).toContain('drop constraint if exists')
  })

  test('credential_secrets keeps auth_type and secret_type as separate columns', () => {
    const sql = v1Up().toLowerCase()
    const block = sql.slice(
      sql.indexOf('credential_secrets'),
      sql.indexOf('outbox_events'),
    )
    expect(block).toContain('auth_type')
    expect(block).toContain('secret_type')
    expect(block).toContain('encrypted_secret')
    expect(block).toContain('key_version')
  })

  test('no master-key table is introduced in the database', () => {
    const sql = v1Up().toLowerCase()
    expect(sql).not.toMatch(/create table[^;]*(master_?key|key_?store|keys)/)
  })

  test('all DDL is idempotent', () => {
    const sql = v1Up().toLowerCase()
    const tables = (sql.match(/create table/g) ?? []).length
    expect(tables).toBeGreaterThanOrEqual(PLAN_TABLES.length)
    for (const create of sql.match(/create table[^;]*/g) ?? []) {
      expect(create).toContain('if not exists')
    }
    for (const create of sql.match(/create index[^;]*/g) ?? []) {
      expect(create).toContain('if not exists')
    }
  })

  test('parameterized writes: no SQL string interpolation in the runner body', () => {
    const source = v1Up()
    expect(source).not.toContain("$1'")
    expect(source).not.toContain(' + ')
  })
})

function mockPool(appliedVersions: number[] = []) {
  const statements: string[] = []
  const client = {
    async query(text: string, _params: unknown[] = []) {
      statements.push(text.trim())
      if (/order by version desc/i.test(text)) {
        return {
          rows: appliedVersions.length
            ? [{ version: Math.max(...appliedVersions) }]
            : [],
        }
      }
      if (/select version from resource_plane\.migrations/i.test(text)) {
        return { rows: appliedVersions.map(version => ({ version })) }
      }
      return { rows: [] }
    },
    async release() {},
  }
  const pool = {
    statements,
    async connect() {
      return client
    },
    async query() {
      return { rows: [] }
    },
    async end() {},
  }
  return pool as unknown as Parameters<typeof runResourcePlaneMigrations>[0]
}

describe('migration runner', () => {
  test('applies all migrations in one transaction when none are applied', async () => {
    const pool = mockPool()
    const result = await runResourcePlaneMigrations(pool)
    expect(result.applied).toEqual([1, 2, 3, 4])
    expect(result.skipped).toEqual([])
    const ordered = pool.statements.join('\n').toLowerCase()
    const begin = ordered.indexOf('begin')
    const create = ordered.indexOf('resource_plane.provider_accounts')
    expect(begin).toBeGreaterThan(-1)
    expect(begin).toBeLessThan(create)
    expect(create).toBeLessThan(ordered.indexOf('commit'))
  })

  test('is idempotent: re-run skips already applied versions and stays a no-op', async () => {
    const pool = mockPool([1, 2, 3, 4])
    const result = await runResourcePlaneMigrations(pool)
    expect(result).toEqual({ applied: [], skipped: [1, 2, 3, 4] })
    const joined = pool.statements.join('\n').toLowerCase().replace(/\s+/g, ' ')
    expect(joined).not.toContain(
      'create table resource_plane.provider_accounts',
    )
    expect(joined).not.toContain('check (')
    expect(joined).not.toContain('add constraint')
  })

  test('applies only the missing migrations in the middle of the sequence', async () => {
    const pool = mockPool([1])
    const result = await runResourcePlaneMigrations(pool)
    expect(result).toEqual({ applied: [2, 3, 4], skipped: [1] })
    const joined = pool.statements.join('\n').toLowerCase()
    expect(joined).toContain('not valid')
    expect(joined).not.toContain(
      'create table resource_plane.provider_accounts',
    )
  })

  test('rolls back on SQL failure and never records the failed migration', async () => {
    const client = {
      calls: [] as string[],
      async query(text: string) {
        this.calls.push(text.trim().toLowerCase())
        if (/select version from resource_plane\.migrations/i.test(text))
          return { rows: [] }
        if (/begin/i.test(text)) return { rows: [] }
        throw new Error('boom')
      },
      async release() {},
    }
    await expect(
      runResourcePlaneMigrations({
        connect: async () => client,
      } as unknown as Parameters<typeof runResourcePlaneMigrations>[0]),
    ).rejects.toThrow('boom')
    expect(client.calls).toContain('rollback')
    expect(client.calls).not.toContain('commit')
  })
})

describe('rollback helper', () => {
  test('rolls back the highest migration that defines a safe down script', async () => {
    const pool = mockPool([1, 2])
    const result = await rollbackLatestResourcePlaneMigration(pool)
    expect(result).toBe(2)
    const joined = pool.statements.join('\n').toLowerCase()
    expect(joined).toContain('drop constraint if exists')
    expect(joined).toContain(
      'delete from resource_plane.migrations where version = $1',
    )
    expect(joined).toContain('commit')
  })

  test('stops at a migration without a down script instead of dropping schema data', async () => {
    const saved = RESOURCE_PLANE_MIGRATIONS.slice()
    try {
      RESOURCE_PLANE_MIGRATIONS.length = 0
      RESOURCE_PLANE_MIGRATIONS.push(...saved.filter(m => m.version === 1))
      const pool = mockPool([1])
      await expect(rollbackLatestResourcePlaneMigration(pool)).rejects.toThrow(
        /no safe rollback defined/,
      )
    } finally {
      RESOURCE_PLANE_MIGRATIONS.length = 0
      RESOURCE_PLANE_MIGRATIONS.push(...saved)
    }
  })

  test('returns null when nothing is applied', async () => {
    const pool = mockPool()
    expect(await rollbackLatestResourcePlaneMigration(pool)).toBeNull()
  })
})
