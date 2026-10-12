import { describe, expect, test } from 'bun:test'

describe('WebUI Edict API 端到端集成测试', () => {
  const WEBUI_BASE = 'http://127.0.0.1:38080'

  test('GET / 返回包含三省六部 Studio 的 HTML 页面', async () => {
    const res = await fetch(`${WEBUI_BASE}/`)
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('CCB Studio · 三省六部三层协同工作台')
    expect(html).toContain('edict-stepper')
    expect(html).toContain('Edict 三省六部流水线')
  })

  test('POST /api/edict 成功执行任务并返回完整三省六部上下文', async () => {
    const res = await fetch(`${WEBUI_BASE}/api/edict`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: '重构并测试 Edict 流水线调度核心' }),
    })
    expect(res.status).toBe(200)
    const data: any = await res.json()
    expect(data.ok).toBe(true)
    expect(data.result).toBeDefined()
    expect(data.result.state).toBe('Done')
    expect(data.result.stateHistory).toContain('Taizi')
    expect(data.result.stateHistory).toContain('Chengxiang')
    expect(data.result.stateHistory).toContain('Zhongshu')
    expect(data.result.stateHistory).toContain('Menxia')
    expect(data.result.stateHistory).toContain('Assigned')
    expect(data.result.stateHistory).toContain('Doing')
    expect(data.result.stateHistory).toContain('Review')
    expect(data.result.stateHistory).toContain('FinalReview')
    expect(data.result.stateHistory).toContain('Done')
    expect(data.result.finalVerdict.accepted).toBe(true)
  })

  test('POST /api/messages 在启用 Edict 流水线时成功记录履职消息', async () => {
    const sessionId = `test-session-${Date.now()}`
    // 创建测试会话
    await fetch(`${WEBUI_BASE}/api/sessions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    })

    const res = await fetch(`${WEBUI_BASE}/api/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        content: '自动化验证三省六部质量门禁',
        useEdict: true,
      }),
    })
    expect(res.status).toBe(200)
    const body: any = await res.json()
    expect(body.ok).toBe(true)

    // 获取会话消息
    const msgRes = await fetch(`${WEBUI_BASE}/api/messages?sessionId=${sessionId}`)
    expect(msgRes.status).toBe(200)
    const messages: any = await msgRes.json()
    expect(messages.length).toBeGreaterThanOrEqual(1)
  })
})
