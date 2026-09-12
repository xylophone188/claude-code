import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeChatGPTAuth } from '../../services/api/openai/chatgptAuth.js'

let launchInput: unknown
let configDirectory: string
let previousConfigDirectory: string | undefined

<<<<<<< Updated upstream
<<<<<<< Updated upstream
// Mock the serviceRef seam (not service.js itself) so workflow tests
// importing '../service.js' directly are not polluted process-globally.
mock.module('src/workflow/serviceRef.js', () => ({
  getWorkflowService: () => ({
    launch: async (input: unknown) => {
      launchInput = input
      return { runId: 'advisor-run' }
    },
  }),
}))
=======
const { default: router, setWorkflowLauncherForTests } = await import(
  '../router.js'
)
>>>>>>> Stashed changes
=======
const { default: router, setWorkflowLauncherForTests } = await import(
  '../router.js'
)
>>>>>>> Stashed changes

const fakeLauncher: Parameters<typeof setWorkflowLauncherForTests>[0] =
  async input => {
    launchInput = input
    return { runId: 'advisor-run' }
  }

function token(accountId: string): string {
  return `x.${Buffer.from(
    JSON.stringify({
      'https://api.openai.com/auth': { chatgpt_account_id: accountId },
    }),
  ).toString('base64url')}.x`
}

async function writeAuth(name: string, accountId: string): Promise<string> {
  const path = join(configDirectory, name)
  const jwt = token(accountId)
  await writeFile(
    path,
    JSON.stringify({
      tokens: {
        id_token: jwt,
        access_token: jwt,
        refresh_token: `refresh-${accountId}`,
      },
    }),
  )
  return path
}

describe('/ccb', () => {
  beforeEach(async () => {
    configDirectory = await mkdtemp(join(tmpdir(), 'ccb-router-'))
    previousConfigDirectory = process.env.CLAUDE_CONFIG_DIR
    process.env.CLAUDE_CONFIG_DIR = configDirectory
    setWorkflowLauncherForTests(fakeLauncher)
  })

  afterEach(async () => {
    setWorkflowLauncherForTests(null)
    await removeChatGPTAuth()
    if (previousConfigDirectory === undefined)
      delete process.env.CLAUDE_CONFIG_DIR
    else process.env.CLAUDE_CONFIG_DIR = previousConfigDirectory
    await rm(configDirectory, { recursive: true, force: true })
  })

  test('enters the local CCB advisor session', async () => {
    let state: Record<string, unknown> = {
      mainLoopModel: 'sonnet',
      mainLoopModelForSession: 'sonnet',
    }
    const { call } = await router.load()

    const result = await call('', {
      setAppState: (update: (current: typeof state) => typeof state) => {
        state = update(state)
      },
    } as any)

    expect(state.mainLoopModel).toBe('advisor')
    expect(state.mainLoopModelForSession).toBeNull()
    expect(result).toEqual({
      type: 'text',
      value: '顾问模式已启用。使用 CCB 本地 Codex 账号池。',
    })
    expect(router.description).toContain('OmniRoute')
  })

  test('starts the advisor workflow for a task', async () => {
    launchInput = undefined
    const { call } = await router.load()

    const result = await call('-p fix the bug', {
      canUseTool: async () => ({ behavior: 'allow' }),
    } as any)

    expect(launchInput).toMatchObject({
      mode: 'advisor',
      args: { task: 'fix the bug' },
    })
    expect(result).toEqual({
      type: 'text',
      value:
        '顾问流水线已后台启动：advisor-run\n用 /workflows 查看方案、执行、复核与验收。',
    })
  })

  test('imports explicit Codex auth files', async () => {
    const first = await writeAuth('first.json', 'first')
    const second = await writeAuth('second.json', 'second')
    const { call } = await router.load()

    const result = await call(`import-codex ${first} ${second}`, {} as any)

    expect(result).toEqual({
      type: 'text',
      value: '已导入 2 个 Codex 账号。',
    })
  })

  test('shows import usage when no auth file is supplied', async () => {
    const { call } = await router.load()

    await expect(call('import-codex', {} as any)).resolves.toEqual({
      type: 'text',
      value: '用法：/ccb import-codex <auth.json...>',
    })
  })

  test('returns import errors without exposing auth contents', async () => {
    const { call } = await router.load()

    const result = await call('import-codex bad.json', {} as any)

    expect(result).toEqual({
      type: 'text',
      value:
        "导入 Codex 账号失败：ENOENT: no such file or directory, open 'bad.json'",
    })
  })

  test('imports Codex auth from an explicit OmniRoute database', async () => {
    const databasePath = join(configDirectory, 'storage.sqlite')
    const database = new Database(databasePath)
    database.run(`CREATE TABLE provider_connections (
      id TEXT, provider TEXT, auth_type TEXT, is_active INTEGER,
      id_token TEXT, access_token TEXT, refresh_token TEXT,
      provider_specific_data TEXT
    )`)
    database.run(`CREATE TABLE quota_snapshots (
      connection_id TEXT, window_key TEXT, is_exhausted INTEGER,
      next_reset_at TEXT, created_at TEXT
    )`)
    const jwt = token('omniroute')
    database.run(
      `INSERT INTO provider_connections VALUES
        ('one', 'codex', 'oauth', 1, ?, ?, 'refresh', '{}')`,
      [jwt, jwt],
    )
    database.close()
    const { call } = await router.load()

    const result = await call(`import-omniroute ${databasePath}`, {} as any)

    expect(result).toEqual({
      type: 'text',
      value: '已从 OmniRoute 导入 1 个 Codex 账号。',
    })
  })

  test('shows OmniRoute import usage when no database is supplied', async () => {
    const { call } = await router.load()

    await expect(call('import-omniroute', {} as any)).resolves.toEqual({
      type: 'text',
      value: '用法：/ccb import-omniroute <storage.sqlite>',
    })
  })

  test('returns OmniRoute import errors without exposing auth contents', async () => {
    const { call } = await router.load()

    const result = await call('import-omniroute missing.sqlite', {} as any)

    expect(result).toEqual({
      type: 'text',
      value: '导入 OmniRoute Codex 账号失败：unable to open database file',
    })
  })
})
