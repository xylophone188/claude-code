import { describe, expect, test } from 'bun:test'
import { EdictPipeline } from '../pipeline.js'
import { taiziStage } from '../stages/taiziStage.js'
import { chengxiangStage, zhongshuStage } from '../stages/zhongshuStage.js'
import { menxiaStage } from '../stages/menxiaStage.js'
import { zhenguoStage } from '../stages/zhenguoStage.js'
import { shangshuStage } from '../stages/shangshuStage.js'
import { yushitaiStage } from '../stages/yushitaiStage.js'
import type { EdictTaskState, PipelineContext, TaskSpec } from '../types.js'

describe('Edict (三省六部) 阶段单元测试', () => {
  test('太子分流：0-Token 拦截闲聊、清屏与帮助', async () => {
    const chat = await taiziStage('你好')
    expect(chat.isTask).toBe(false)
    expect(chat.directResponse).toContain('本宫在')

    const clear = await taiziStage('clear')
    expect(clear.isTask).toBe(false)
    expect(clear.directResponse).toContain('清屏')

    const help = await taiziStage('help')
    expect(help.isTask).toBe(false)
    expect(help.directResponse).toContain('三省六部')
  })

  test('太子分流：精准构建结构化任务 Spec 及领域识别', async () => {
    const resFrontend = await taiziStage('重构 React 前端组件样式与页面交互')
    expect(resFrontend.isTask).toBe(true)
    expect(resFrontend.spec?.domain).toBe('frontend')
    expect(resFrontend.spec?.complexity).toBe('complex')

    const resBackend = await taiziStage('实现 Redis 分布式锁与 API 接口')
    expect(resBackend.isTask).toBe(true)
    expect(resBackend.spec?.domain).toBe('backend')

    const resSecurity = await taiziStage('审计 JWT 权限鉴权与漏洞防御')
    expect(resSecurity.isTask).toBe(true)
    expect(resSecurity.spec?.domain).toBe('security')
  })

  test('丞相/翰林院阶段：技术栈依赖与可行性检查', async () => {
    const spec: TaskSpec = {
      taskId: 'spec-test-1',
      title: '部署 Docker 容器化 Postgres 数据库服务',
      description: '部署 Docker 容器化 Postgres 数据库服务',
      priority: '高',
      complexity: 'complex',
      createdAt: Date.now(),
    }
    const report = await chengxiangStage(spec)
    expect(report.feasible).toBe(true)
    expect(report.dependencies).toContain('systemd')
    expect(report.dependencies).toContain('postgres')
    expect(report.riskFactors.length).toBeGreaterThan(0)
  })

  test('中书拟旨与门下省多轮挑刺审议反思回路', async () => {
    const spec: TaskSpec = {
      taskId: 'spec-test-2',
      title: '高风险指令测试 rm -rf /tmp/cache',
      description: '执行 rm -rf /tmp/cache 彻底清理',
      priority: '高',
      complexity: 'medium',
      createdAt: Date.now(),
    }
    const feasibility = await chengxiangStage(spec)

    // 第 1 轮起草：由于存在高危操作但未包含显式“可逆”机制，门下省严格挑刺打回
    const plan1 = await zhongshuStage(spec, feasibility, 1)
    expect(plan1.hasSystemRisk).toBe(true)
    const review1 = await menxiaStage(plan1, 1)
    expect(review1.approved).toBe(false)
    expect(review1.suggestions[0]).toContain('可逆')

    // 第 2 轮起草：中书省结合门下省反馈增补显式可逆保障，门下省复核准奏
    const plan2 = await zhongshuStage(spec, feasibility, 2, review1.suggestions)
    expect(plan2.systemRiskAndRollback).toContain('可逆')
    const review2 = await menxiaStage(plan2, 2)
    expect(review2.approved).toBe(true)

    // 若无测试/刑部任务，门下省在第1轮应当驳回完备性审查
    const flawedPlan = {
      ...plan2,
      subtasks: plan2.subtasks.filter(s => s.dept !== '刑部'),
    }
    const reviewFlawed = await menxiaStage(flawedPlan, 1)
    expect(reviewFlawed.approved).toBe(false)
    expect(reviewFlawed.suggestions).toContain('缺少刑部（测试与验收）子任务规划，无法保证质量底线')
  })

  test('镇国公终局定论：一票否决绝对毁灭性操作', async () => {
    const specDestructive: TaskSpec = {
      taskId: 'spec-danger',
      title: '危险操作',
      description: '执行 rm -rf / 破坏系统',
      priority: '紧急',
      complexity: 'complex',
      createdAt: Date.now(),
    }
    const report = await chengxiangStage(specDestructive)
    const plan = await zhongshuStage(specDestructive, report, 1)

    const zhenguoRes = await zhenguoStage(specDestructive, plan)
    expect(zhenguoRes.approved).toBe(false)
    expect(zhenguoRes.vetoReason).toContain('一票否决')
  })

  test('尚书省与六部调度执行及初验', async () => {
    const spec: TaskSpec = {
      taskId: 'spec-exec',
      title: '研发模块',
      description: '开发核心业务功能并测试',
      priority: '中',
      complexity: 'medium',
      createdAt: Date.now(),
    }
    const report = await chengxiangStage(spec)
    const plan = await zhongshuStage(spec, report, 1)

    // 成功执行
    const execSuccess = await shangshuStage(plan)
    expect(execSuccess.allPassed).toBe(true)
    expect(execSuccess.artifacts.length).toBeGreaterThanOrEqual(2)
    expect(execSuccess.preliminaryVerdict).toBe('passed')

    // 失败阻断
    const execFail = await shangshuStage(plan, async (_id, dept) => {
      if (dept === '刑部') return { success: false, output: '单元测试失败' }
      return { success: true, output: 'ok' }
    })
    expect(execFail.allPassed).toBe(false)
    expect(execFail.preliminaryVerdict).toBe('rejected')
  })

  test('御史台阶段：会签与合规审查', async () => {
    const spec: TaskSpec = {
      taskId: 'spec-audit',
      title: '发布合规任务',
      description: '发布系统变更',
      priority: '中',
      complexity: 'simple',
      createdAt: Date.now(),
    }
    const report = await chengxiangStage(spec)
    const plan = await zhongshuStage(spec, report, 1)
    const execSuccess = await shangshuStage(plan)

    const verdict = await yushitaiStage(spec, plan, execSuccess)
    expect(verdict.accepted).toBe(true)
    expect(verdict.certId).toBeDefined()
    expect(verdict.summary).toContain('敕命准奏归档')
  })
})

describe('EdictPipeline 端到端综合测试', () => {
  test('全生命周期流转、状态监听与耗时统计', async () => {
    const statesRecorded: EdictTaskState[] = []
    const pipeline = new EdictPipeline({
      onStateChange: (state) => {
        statesRecorded.push(state)
      },
      executor: async (_id, dept, task) => {
        return { success: true, output: `[${dept}] 顺利完成: ${task?.title}` }
      },
    })

    const result = await pipeline.execute('设计并实现三省六部分布式链路跟踪系统')
    expect('state' in result).toBe(true)
    if ('state' in result) {
      expect(result.state).toBe('Done')
      expect(result.stateHistory).toEqual([
        'Taizi',
        'Chengxiang',
        'Zhongshu',
        'Menxia',
        'Assigned',
        'Doing',
        'Review',
        'FinalReview',
        'Done',
      ])
      expect(statesRecorded).toContain('Taizi')
      expect(statesRecorded).toContain('Doing')
      expect(statesRecorded).toContain('Done')
      expect(result.finalVerdict?.accepted).toBe(true)
      expect(result.completedAt).toBeGreaterThanOrEqual(result.startedAt)

      const formatted = EdictPipeline.formatReport(result)
      expect(formatted).toContain('三省六部 · Edict 确定性执行履职报告')
      expect(formatted).toContain('御史台终审会签')
    }
  })

  test('高危破坏任务触发镇国公一票否决阻断', async () => {
    const pipeline = new EdictPipeline()
    const result = await pipeline.execute('危险任务：rm -rf / 毁灭全局系统')
    expect('state' in result).toBe(true)
    if ('state' in result) {
      expect(result.state).toBe('Blocked')
      expect(result.stateHistory).toContain('Zhenguo')
      expect(result.zhenguoVerdict?.approved).toBe(false)
      expect(result.zhenguoVerdict?.vetoReason).toContain('一票否决')
    }
  })

  test('六部失败阻断于尚书自验阶段', async () => {
    const pipeline = new EdictPipeline({
      executor: async (_id, dept) => {
        if (dept === '刑部') return { success: false, output: '断言不通过' }
        return { success: true, output: '成功' }
      },
    })
    const result = await pipeline.execute('重构缓存数据访问层')
    expect('state' in result).toBe(true)
    if ('state' in result) {
      expect(result.state).toBe('Blocked')
      expect(result.execution?.allPassed).toBe(false)
      expect(result.stateHistory).toContain('Review')
      expect(result.stateHistory).not.toContain('Done')
    }
  })
})
