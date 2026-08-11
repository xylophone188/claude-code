import { afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const TMP = mkdtempSync(join(tmpdir(), 'ccb-cn-test-'))
// Direct the module's config dir to an isolated temp location.
process.env.CLAUDE_CONFIG_DIR = TMP

const cn = await import('../codebuddyCnAuth.js')

function writeFixtureDb(path: string): void {
  const db = new Database(path, { create: true })
  db.run(
    `CREATE TABLE providerConnections (
      id TEXT PRIMARY KEY, provider TEXT NOT NULL, authType TEXT NOT NULL,
      isActive INTEGER DEFAULT 1, data TEXT NOT NULL)`,
  )
  const rows = [
    {
      id: 'acc-1',
      provider: 'codebuddy-cn',
      authType: 'oauth',
      isActive: 1,
      accessToken: 'at-1',
      refreshToken: 'rt-1',
    },
    {
      id: 'acc-2',
      provider: 'codebuddy-cn',
      authType: 'oauth',
      isActive: 1,
      accessToken: 'at-2',
      refreshToken: 'rt-2',
    },
    {
      // inactive — must be skipped by the importer
      id: 'acc-3',
      provider: 'codebuddy-cn',
      authType: 'oauth',
      isActive: 0,
      accessToken: 'at-3',
      refreshToken: 'rt-3',
    },
  ]
  const stmt = db.prepare(
    `INSERT INTO providerConnections (id, provider, authType, isActive, data)
     VALUES (?, ?, ?, ?, ?)`,
  )
  for (const r of rows) {
    stmt.run(
      r.id,
      r.provider,
      r.authType,
      r.isActive,
      JSON.stringify({
        accessToken: r.accessToken,
        refreshToken: r.refreshToken,
      }),
    )
  }
  db.close()
}

describe('codebuddyCnAuth pool', () => {
  afterEach(() => {
    // Clear the pool between tests by removing the file.
    try {
      rmSync(join(TMP, 'codebuddy-cn-auth.json'))
    } catch {
      /* ignore missing */
    }
  })

  test('mergeStoredCnPool is ADD-only and idempotent by accountId', async () => {
    await cn.mergeStoredCnPool([
      { accountId: 'a', accessToken: 'at-a', refreshToken: 'rt-a' },
    ])
    await cn.mergeStoredCnPool([
      { accountId: 'b', accessToken: 'at-b', refreshToken: 'rt-b' },
      { accountId: 'a', accessToken: 'at-a-2', refreshToken: 'rt-a-2' },
    ])
    const pool = await cn.readCodeBuddyCnPool()
    expect(pool.map(p => p.accountId).sort()).toEqual(['a', 'b'])
    // account 'a' was refreshed (latest write wins), never duplicated
    const a = pool.find(p => p.accountId === 'a')!
    expect(a.accessToken).toBe('at-a-2')
    expect(pool.length).toBe(2)
  })

  test('importCodeBuddyCnFrom9Router is read-only on source and ADD-only', async () => {
    const dbPath = join(TMP, '9router.sqlite')
    writeFixtureDb(dbPath)
    const imported = await cn.importCodeBuddyCnFrom9Router(dbPath)
    expect(imported).toBe(2) // only the 2 active rows
    const pool = await cn.readCodeBuddyCnPool()
    expect(pool.map(p => p.accountId).sort()).toEqual(['acc-1', 'acc-2'])
    expect(pool[0]!.accessToken).toBe('at-1')
    expect(pool[0]!.refreshToken).toBe('rt-1')
  })
})
