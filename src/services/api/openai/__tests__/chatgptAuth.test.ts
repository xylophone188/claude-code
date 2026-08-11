import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { chmod, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  clearChatGPTAccountFailure,
  getValidChatGPTAuth,
  hasChatGPTAccountPool,
  importChatGPTAuthFiles,
  importChatGPTAuthFromOmniRoute,
  markChatGPTAccountAuthRejected,
  markChatGPTAccountFailure,
  markChatGPTAccountQuotaExhausted,
} from '../chatgptAuth.js'

let directory: string
let previousConfigDir: string | undefined

function token(accountId: string, expiresInSeconds = 3_600): string {
  return `x.${Buffer.from(
    JSON.stringify({
      exp: Math.floor(Date.now() / 1000) + expiresInSeconds,
      'https://api.openai.com/auth': { chatgpt_account_id: accountId },
    }),
  ).toString('base64url')}.x`
}

async function writeAuth(
  name: string,
  accountId: string,
  expiresInSeconds?: number,
): Promise<string> {
  const path = join(directory, name)
  const jwt = token(accountId, expiresInSeconds)
  await writeFile(
    path,
    JSON.stringify({
      auth_mode: 'chatgpt',
      tokens: {
        id_token: jwt,
        access_token: jwt,
        refresh_token: `refresh-${accountId}`,
      },
    }),
  )
  return path
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'chatgpt-auth-'))
  previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  process.env.CLAUDE_CONFIG_DIR = directory
})

afterEach(async () => {
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
})

describe('ChatGPT auth pool', () => {
  test('imports Codex auth files once into CCB-owned 0600 storage', async () => {
    const first = await writeAuth('first.json', 'account-1')
    const second = await writeAuth('second.json', 'account-2')

    expect(await importChatGPTAuthFiles([first, second])).toBe(2)
    expect(await hasChatGPTAccountPool()).toBe(true)
    expect(
      (await stat(join(directory, 'openai-chatgpt-auth.json'))).mode & 0o777,
    ).toBe(0o600)
  })

  test('imports every account from a CCB auth-pool file', async () => {
    const first = token('pool-account-1')
    const second = token('pool-account-2')
    const path = join(directory, 'pool.json')
    await writeFile(
      path,
      JSON.stringify({
        auth_mode: 'chatgpt',
        accounts: [
          {
            tokens: {
              id_token: first,
              access_token: first,
              refresh_token: 'refresh-1',
            },
          },
          {
            tokens: {
              id_token: second,
              access_token: second,
              refresh_token: 'refresh-2',
            },
          },
        ],
      }),
    )

    expect(await importChatGPTAuthFiles([path])).toBe(2)
    expect((await getValidChatGPTAuth()).accountId).toBe('pool-account-1')
  })

  test('uses next account after caller marks returned auth failed', async () => {
    const first = await writeAuth('first.json', 'account-1')
    const second = await writeAuth('second.json', 'account-2')
    await importChatGPTAuthFiles([first, second])

    const auth = await getValidChatGPTAuth()
    markChatGPTAccountFailure(auth)
    expect((await getValidChatGPTAuth()).accountId).toBe('account-2')
    clearChatGPTAccountFailure(auth)
  })

  test('does not reuse an account marked failed in this process', async () => {
    const first = await writeAuth('first.json', 'account-1')
    await importChatGPTAuthFiles([first])
    const auth = await getValidChatGPTAuth()
    markChatGPTAccountFailure(auth)
    await expect(getValidChatGPTAuth()).rejects.toThrow(
      'No ChatGPT account has a valid token',
    )
    clearChatGPTAccountFailure(auth)
  })

  test('keeps a confirmed quota-exhausted account skipped after restart', async () => {
    const first = await writeAuth('first.json', 'quota-account-1')
    const second = await writeAuth('second.json', 'quota-account-2')
    await importChatGPTAuthFiles([first, second])
    const auth = await getValidChatGPTAuth()
    await markChatGPTAccountQuotaExhausted(
      auth,
      (async () =>
        new Response(
          JSON.stringify({
            rate_limit: {
              secondary_window: {
                used_percent: 100,
                reset_after_seconds: 3600,
              },
            },
          }),
        )) as unknown as typeof fetch,
    )
    clearChatGPTAccountFailure(auth)
    const restarted = await import(`../chatgptAuth.js?restart=${Date.now()}`)
    expect((await restarted.getValidChatGPTAuth()).accountId).toBe(
      'quota-account-2',
    )
  })

  test('does not recheck a known weekly quota before its reset', async () => {
    const first = await writeAuth('weekly-first.json', 'weekly-account-1')
    const second = await writeAuth('weekly-second.json', 'weekly-account-2')
    await importChatGPTAuthFiles([first, second])
    await markChatGPTAccountQuotaExhausted(
      await getValidChatGPTAuth(),
      (async () =>
        new Response(
          JSON.stringify({
            rate_limit: {
              secondary_window: {
                used_percent: 100,
                reset_after_seconds: 7 * 24 * 60 * 60,
              },
            },
          }),
        )) as unknown as typeof fetch,
    )

    const originalFetch = globalThis.fetch
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      throw new Error('weekly account must stay skipped')
    }) as unknown as typeof fetch
    try {
      const restarted = await import(`../chatgptAuth.js?weekly=${Date.now()}`)
      expect((await restarted.getValidChatGPTAuth()).accountId).toBe(
        'weekly-account-2',
      )
      expect(calls).toBe(0)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('observes a quota lock written by another CCB process', async () => {
    const first = await writeAuth('shared-first.json', 'shared-account-1')
    const second = await writeAuth('shared-second.json', 'shared-account-2')
    await importChatGPTAuthFiles([first, second])
    expect((await getValidChatGPTAuth()).accountId).toBe('shared-account-1')

    const other = await import(`../chatgptAuth.js?other=${Date.now()}`)
    await other.markChatGPTAccountQuotaExhausted(
      await other.getValidChatGPTAuth(),
      (async () =>
        new Response(
          JSON.stringify({
            rate_limit: {
              secondary_window: {
                used_percent: 100,
                reset_after_seconds: 7 * 24 * 60 * 60,
              },
            },
          }),
        )) as unknown as typeof fetch,
    )

    expect((await getValidChatGPTAuth()).accountId).toBe('shared-account-2')
  })

  test('does not unlock quota on an incomplete usage response', async () => {
    const first = await writeAuth('first.json', 'unknown-quota-account-1')
    const second = await writeAuth('second.json', 'unknown-quota-account-2')
    await importChatGPTAuthFiles([first, second])
    const auth = await getValidChatGPTAuth()
    await markChatGPTAccountQuotaExhausted(
      auth,
      (async () =>
        new Response(
          JSON.stringify({ rate_limit: {} }),
        )) as unknown as typeof fetch,
    )
    const quotaPath = join(directory, 'openai-chatgpt-quota.json')
    const locks = JSON.parse(await readFile(quotaPath, 'utf8')) as {
      accounts: Record<string, { checkedAt: string }>
    }
    locks.accounts['unknown-quota-account-1']!.checkedAt = new Date(
      Date.now() - 6 * 60 * 1000,
    ).toISOString()
    await writeFile(quotaPath, `${JSON.stringify(locks)}\n`)
    clearChatGPTAccountFailure(auth)
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({ rate_limit: {} }),
      )) as unknown as typeof fetch
    try {
      const restarted = await import(`../chatgptAuth.js?unknown=${Date.now()}`)
      expect((await restarted.getValidChatGPTAuth()).accountId).toBe(
        'unknown-quota-account-2',
      )
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('keeps an auth-rejected (401/403) account skipped after restart', async () => {
    const first = await writeAuth('first.json', 'reject-account-1')
    const second = await writeAuth('second.json', 'reject-account-2')
    await importChatGPTAuthFiles([first, second])
    const auth = await getValidChatGPTAuth()
    // The old markChatGPTAccountFailure was process-local only and was lost on
    // restart, so a fresh `bun run dev` re-tried dead accounts forever. This
    // durable rejection must survive a restart (module reload) like quota.
    await markChatGPTAccountAuthRejected(auth)
    clearChatGPTAccountFailure(auth)
    const restarted = await import(`../chatgptAuth.js?reject=${Date.now()}`)
    expect((await restarted.getValidChatGPTAuth()).accountId).toBe(
      'reject-account-2',
    )
  })

  test('accepts an explicitly reimported auth-rejected account', async () => {
    const source = await writeAuth('reimport.json', 'reimport-account')
    await importChatGPTAuthFiles([source])
    await markChatGPTAccountAuthRejected(await getValidChatGPTAuth())

    await importChatGPTAuthFiles([source])
    const restarted = await import(`../chatgptAuth.js?reimport=${Date.now()}`)
    expect((await restarted.getValidChatGPTAuth()).accountId).toBe(
      'reimport-account',
    )
  })

  test('unlocks a quota account when its recorded reset passes', async () => {
    const source = await writeAuth('reset.json', 'reset-account')
    await importChatGPTAuthFiles([source])
    const auth = await getValidChatGPTAuth()
    await markChatGPTAccountQuotaExhausted(
      auth,
      (async () =>
        new Response(
          JSON.stringify({
            rate_limit: {
              secondary_window: { used_percent: 100, reset_at: Date.now() - 1 },
            },
          }),
        )) as unknown as typeof fetch,
    )
    const restarted = await import(`../chatgptAuth.js?reset=${Date.now()}`)
    expect((await restarted.getValidChatGPTAuth()).accountId).toBe(
      'reset-account',
    )
  })

  test('retries a quota account in the same process when its reset passes', async () => {
    const source = await writeAuth(
      'same-process-reset.json',
      'same-process-reset-account',
    )
    await importChatGPTAuthFiles([source])
    await markChatGPTAccountQuotaExhausted(
      await getValidChatGPTAuth(),
      (async () =>
        new Response(
          JSON.stringify({
            rate_limit: {
              secondary_window: { used_percent: 100, reset_at: Date.now() - 1 },
            },
          }),
        )) as unknown as typeof fetch,
    )

    expect((await getValidChatGPTAuth()).accountId).toBe(
      'same-process-reset-account',
    )
  })

  test('refreshes expired token in CCB-owned pool', async () => {
    const source = await writeAuth('expired.json', 'account-3', -60)
    await importChatGPTAuthFiles([source])
    const fresh = token('account-3')
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          id_token: fresh,
          access_token: fresh,
          refresh_token: 'refresh-account-3-new',
        }),
      )) as unknown as typeof fetch
    try {
      expect((await getValidChatGPTAuth()).accountId).toBe('account-3')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  test('imports active Codex OAuth rows from OmniRoute SQLite once', async () => {
    const databasePath = join(directory, 'omniroute.sqlite')
    let database = new Database(databasePath)
    database.run(`CREATE TABLE provider_connections (
      id TEXT, provider TEXT, auth_type TEXT, is_active INTEGER,
      id_token TEXT, access_token TEXT, refresh_token TEXT,
      provider_specific_data TEXT
    )`)
    database.run(`CREATE TABLE quota_snapshots (
      connection_id TEXT, window_key TEXT, is_exhausted INTEGER, next_reset_at TEXT,
      created_at TEXT
    )`)
    const first = token('omniroute-account-1')
    const second = token('omniroute-account-2')
    database.run(
      `INSERT INTO provider_connections VALUES
        ('one', 'codex', 'oauth', 1, ?, ?, 'refresh-1', '{}'),
        ('two', 'codex', 'oauth', 1, ?, ?, 'refresh-2', '{"workspaceId":"omniroute-account-2"}'),
        ('three', 'codex', 'oauth', 0, ?, ?, 'refresh-3', '{}'),
        ('four', 'openai', 'apikey', 1, ?, ?, 'refresh-4', '{}')`,
      [first, first, second, second, first, first, first, first],
    )
    database.run(
      `INSERT INTO quota_snapshots VALUES ('one', 'weekly', 1, ?, '2026-01-01')`,
      [new Date(Date.now() + 3_600_000).toISOString()],
    )
    database.close()

    expect(await importChatGPTAuthFromOmniRoute(databasePath)).toBe(2)
    expect((await getValidChatGPTAuth()).accountId).toBe('omniroute-account-2')

    database = new Database(databasePath)
    database.run(
      `INSERT INTO quota_snapshots VALUES ('one', 'weekly', 0, NULL, ?)`,
      [new Date(Date.now() + 1_000).toISOString()],
    )
    database.close()
    expect(await importChatGPTAuthFromOmniRoute(databasePath)).toBe(2)
    expect((await getValidChatGPTAuth()).accountId).toBe('omniroute-account-1')
  })

  test('does not clear an auth lock on OmniRoute reimport', async () => {
    const databasePath = join(directory, 'omniroute-auth-lock.sqlite')
    const database = new Database(databasePath)
    database.run(`CREATE TABLE provider_connections (
      id TEXT, provider TEXT, auth_type TEXT, is_active INTEGER,
      id_token TEXT, access_token TEXT, refresh_token TEXT,
      provider_specific_data TEXT
    )`)
    database.run(`CREATE TABLE quota_snapshots (
      connection_id TEXT, window_key TEXT, is_exhausted INTEGER, next_reset_at TEXT,
      created_at TEXT
    )`)
    const jwt = token('omniroute-auth-lock')
    database.run(
      `INSERT INTO provider_connections VALUES
        ('one', 'codex', 'oauth', 1, ?, ?, 'refresh', '{}')`,
      [jwt, jwt],
    )
    database.run(
      `INSERT INTO quota_snapshots VALUES ('one', 'weekly', 0, NULL, ?)`,
      [new Date().toISOString()],
    )
    database.close()

    await importChatGPTAuthFromOmniRoute(databasePath)
    await markChatGPTAccountAuthRejected(await getValidChatGPTAuth())
    await importChatGPTAuthFromOmniRoute(databasePath)
    const restarted = await import(`../chatgptAuth.js?omniroute=${Date.now()}`)
    await expect(restarted.getValidChatGPTAuth()).rejects.toThrow(
      'No ChatGPT account has a valid token',
    )
  })

  test('keeps existing CCB accounts while refreshing the OmniRoute source', async () => {
    const stale = await writeAuth('stale.json', 'stale-account')
    await importChatGPTAuthFiles([stale])
    const databasePath = join(directory, 'omniroute-replace.sqlite')
    const database = new Database(databasePath)
    database.run(`CREATE TABLE provider_connections (
      id TEXT, provider TEXT, auth_type TEXT, is_active INTEGER,
      id_token TEXT, access_token TEXT, refresh_token TEXT,
      provider_specific_data TEXT
    )`)
    database.run(`CREATE TABLE quota_snapshots (
      connection_id TEXT, window_key TEXT, is_exhausted INTEGER, next_reset_at TEXT,
      created_at TEXT
    )`)
    const fresh = token('fresh-account')
    database.run(
      `INSERT INTO provider_connections VALUES
        ('fresh', 'codex', 'oauth', 1, ?, ?, 'refresh-fresh', '{}')`,
      [fresh, fresh],
    )
    database.close()

    expect(await importChatGPTAuthFromOmniRoute(databasePath)).toBe(1)
    const first = await getValidChatGPTAuth()
    expect(first.accountId).toBe('stale-account')
    markChatGPTAccountFailure(first)
    expect((await getValidChatGPTAuth()).accountId).toBe('fresh-account')
    clearChatGPTAccountFailure(first)
  })

  test('rejects input without a stable account id', async () => {
    const path = join(directory, 'invalid.json')
    await writeFile(
      path,
      JSON.stringify({
        tokens: {
          id_token: 'not-a-jwt',
          access_token: 'not-a-jwt',
          refresh_token: 'refresh',
        },
      }),
    )
    await chmod(path, 0o600)

    await expect(importChatGPTAuthFiles([path])).rejects.toThrow(
      'Invalid Codex auth file',
    )
  })
})
