import { describe, expect, test } from 'bun:test'
import edict from '../index.js'

describe('/edict 命令集成测试', () => {
  test('edict 命令基础元信息与类型属性', () => {
    expect(edict.name).toBe('edict')
    expect(edict.type).toBe('local')
    expect(edict.supportsNonInteractive).toBe(true)
    expect(edict.isEnabled()).toBe(true)
  })

  test('未传参数或 help 时输出用法指引', async () => {
    const loaded = await edict.load()
    const resHelp = await loaded.call('help', {} as any)
    expect(resHelp.type).toBe('text')
    if (resHelp.type === 'text') {
      expect(resHelp.value).toContain('Edict 三省六部确定性流水线')
      expect(resHelp.value).toContain('用法: /edict')
    }

    const resEmpty = await loaded.call('', {} as any)
    expect(resEmpty.type).toBe('text')
    if (resEmpty.type === 'text') {
      expect(resEmpty.value).toContain('用法: /edict')
    }
  })

  test('传入问答/闲聊时直接输出答复', async () => {
    const loaded = await edict.load()
    const resChat = await loaded.call('你好', {} as any)
    expect(resChat.type).toBe('text')
    if (resChat.type === 'text') {
      expect(resChat.value).toContain('本宫在')
    }
  })

  test('传入正式任务时端到端执行并输出格式化履职报告', async () => {
    const loaded = await edict.load()
    const resTask = await loaded.call('部署与配置高可用三省六部网关', {} as any)
    expect(resTask.type).toBe('text')
    if (resTask.type === 'text') {
      expect(resTask.value).toContain('【三省六部 · Edict 确定性执行履职报告】')
      expect(resTask.value).toContain('当前状态: [Done]')
      expect(resTask.value).toContain('御史台终审会签')
    }
  })
})
