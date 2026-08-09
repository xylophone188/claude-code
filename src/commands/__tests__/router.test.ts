import { describe, expect, mock, test } from 'bun:test'

let launchInput: unknown

mock.module('src/workflow/service.js', () => ({
  getWorkflowService: () => ({
    launch: async (input: unknown) => {
      launchInput = input
      return { runId: 'advisor-run' }
    },
  }),
}))

const router = (await import('../router.js')).default

describe('/ccb', () => {
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
    expect(router.description).not.toContain('OmniRoute')
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
})
