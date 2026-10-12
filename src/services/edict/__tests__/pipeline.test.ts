import { describe, expect, test } from 'bun:test'
import { EdictPipeline } from '../pipeline.js'

describe('EdictPipeline 确定性代码流水线测试', () => {
  test('简单闲聊直出，不进入三省六部流水线', async () => {
    const pipeline = new EdictPipeline()
    const result = await pipeline.execute('你好')
    expect('directResponse' in result).toBe(true)
    if ('directResponse' in result) {
      expect(result.directResponse).toContain('本宫在')
    }
  })

  test('常规任务经历太子->中书->门下->尚书->御史台全生命周期且标记 Done', async () => {
    const pipeline = new EdictPipeline({
      executor: async (id, dept) => ({ success: true, output: `${dept}完成` }),
    })
    const result = await pipeline.execute('开发并部署用户认证模块')
    expect('state' in result).toBe(true)
    if ('state' in result) {
      expect(result.state).toBe('Done')
      expect(result.spec.title).toContain('开发并部署用户认证模块')
      expect(result.reviewHistory.length).toBeGreaterThanOrEqual(1)
      expect(result.execution?.allPassed).toBe(true)
      expect(result.finalVerdict?.accepted).toBe(true)
    }
  })

  test('六部执行失败时，尚书省自验阻断为 Blocked 状态', async () => {
    const pipeline = new EdictPipeline({
      executor: async (id, dept) => {
        if (dept === '刑部') return { success: false, output: '单测未通过' }
        return { success: true, output: 'ok' }
      },
    })
    const result = await pipeline.execute('重构数据库访问层')
    expect('state' in result).toBe(true)
    if ('state' in result) {
      expect(result.state).toBe('Blocked')
      expect(result.execution?.allPassed).toBe(false)
      expect(result.execution?.rejectionReason).toContain('尚书省自验不通过')
    }
  })
})
