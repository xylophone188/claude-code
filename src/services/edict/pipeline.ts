import type {
  EdictPipelineOptions,
  EdictTaskState,
  PipelineContext,
} from './types.js'
import { taiziStage } from './stages/taiziStage.js'
import { chengxiangStage, zhongshuStage } from './stages/zhongshuStage.js'
import { menxiaStage } from './stages/menxiaStage.js'
import { zhenguoStage } from './stages/zhenguoStage.js'
import { shangshuStage } from './stages/shangshuStage.js'
import { yushitaiStage } from './stages/yushitaiStage.js'

export class EdictPipeline {
  private options?: EdictPipelineOptions

  constructor(options?: EdictPipelineOptions) {
    this.options = options
  }

  private stageStartTimestamps: Map<string, number> = new Map()

  /**
   * 记录状态流转并向外部监听者分发回调
   */
  private async transitionTo(
    state: EdictTaskState,
    context: PipelineContext,
  ): Promise<void> {
    const now = Date.now()
    if (!context.stageDurations) {
      context.stageDurations = {}
    }
    if (context.state) {
      const stageStart =
        this.stageStartTimestamps.get(context.state) ?? context.startedAt
      context.stageDurations[context.state] = now - stageStart
    }
    this.stageStartTimestamps.set(state, now)

    context.state = state
    if (!context.stateHistory.includes(state)) {
      context.stateHistory.push(state)
    }

    if (this.options?.onStateChange) {
      try {
        await this.options.onStateChange(state, context)
      } catch (err) {
        // 外部状态回调异常不中断核心流水线
        console.error('[EdictPipeline] onStateChange callback error:', err)
      }
    }
  }

  /**
   * 运行端到端确定性三省六部流水线
   */
  async execute(
    input: string,
  ): Promise<PipelineContext | { directResponse: string }> {
    // 1. 太子分流：0-Token 拦截与任务 Spec 建立
    const taiziRes = await taiziStage(input, {
      defaultPriority: this.options?.defaultPriority,
    })
    if (!taiziRes.isTask || !taiziRes.spec) {
      return { directResponse: taiziRes.directResponse ?? '处理完毕' }
    }

    const now = Date.now()
    const context: PipelineContext = {
      spec: taiziRes.spec,
      state: 'Taizi',
      stateHistory: ['Taizi'],
      startedAt: now,
      stageDurations: {},
      reviewHistory: [],
    }

    if (this.options?.onStateChange) {
      await this.options.onStateChange('Taizi', context)
    }

    // 2. 丞相可行性评估
    await this.transitionTo('Chengxiang', context)
    context.feasibility = await chengxiangStage(context.spec)
    if (!context.feasibility.feasible) {
      await this.transitionTo('Blocked', context)
      context.completedAt = Date.now()
      return context
    }

    // 3. 中书拟旨、门下挑刺与镇国公定论循环 (最多 maxReviewRounds 轮，默认 3 轮)
    const maxRounds = this.options?.maxReviewRounds ?? 3
    let round = 1
    let approved = false

    while (round <= maxRounds && !approved) {
      await this.transitionTo('Zhongshu', context)
      const lastFeedback = context.reviewHistory.at(-1)?.suggestions
      context.draftPlan = await zhongshuStage(
        context.spec,
        context.feasibility,
        round,
        lastFeedback,
      )

      await this.transitionTo('Menxia', context)
      const verdict = await menxiaStage(context.draftPlan, round)
      context.reviewHistory.push(verdict)

      // 镇国公裁决：若存在系统高危破坏性风险，或显式启用镇国公阶段
      if (
        context.draftPlan.hasSystemRisk &&
        this.options?.enableZhenguo !== false
      ) {
        await this.transitionTo('Zhenguo', context)
        const zhenguoRes = await zhenguoStage(context.spec, context.draftPlan)
        context.zhenguoVerdict = zhenguoRes
        if (!zhenguoRes.approved) {
          await this.transitionTo('Blocked', context)
          context.completedAt = Date.now()
          return context
        }
      }

      if (verdict.approved) {
        approved = true
      } else {
        round++
      }
    }

    if (!approved) {
      await this.transitionTo('Blocked', context)
      context.completedAt = Date.now()
      return context
    }

    // 4. 尚书省拆解派发与六部执行
    await this.transitionTo('Assigned', context)
    await this.transitionTo('Doing', context)
    context.execution = await shangshuStage(
      context.draftPlan!,
      this.options?.executor,
    )

    // 5. 尚书省初验自查
    await this.transitionTo('Review', context)
    if (!context.execution.allPassed) {
      await this.transitionTo('Blocked', context)
      context.completedAt = Date.now()
      return context
    }

    // 6. 御史台终审纪检
    await this.transitionTo('FinalReview', context)
    context.finalVerdict = await yushitaiStage(
      context.spec,
      context.draftPlan!,
      context.execution,
    )
    if (!context.finalVerdict.accepted) {
      await this.transitionTo('Blocked', context)
      context.completedAt = Date.now()
      return context
    }

    // 7. 准奏归档完成
    await this.transitionTo('Done', context)
    context.completedAt = Date.now()

    return context
  }

  /**
   * 将流水线执行上下文格式化为易读的结构化报告
   */
  static formatReport(context: PipelineContext): string {
    const lines: string[] = []
    lines.push(
      `╔══════════════════════════════════════════════════════════════╗`,
    )
    lines.push(
      `║       📜 【三省六部 · Edict 确定性执行履职报告】             ║`,
    )
    lines.push(
      `╚══════════════════════════════════════════════════════════════╝`,
    )
    lines.push(`任务标的: ${context.spec.title}`)
    lines.push(`任务编号: ${context.spec.taskId}`)
    lines.push(
      `优先级: ${context.spec.priority} | 复杂度: ${context.spec.complexity} | 领域: ${context.spec.domain ?? 'general'}`,
    )
    lines.push(`当前状态: [${context.state}]`)
    lines.push(`流转足迹: ${context.stateHistory.join(' -> ')}`)
    lines.push(``)

    if (context.feasibility) {
      lines.push(`【🏛️ 丞相可行性评估】`)
      lines.push(
        `  - 评估结论: ${context.feasibility.feasible ? '可行' : '不可行'}`,
      )
      lines.push(
        `  - 技术栈依赖: ${context.feasibility.dependencies.join(', ') || '无'}`,
      )
      if (context.feasibility.riskFactors.length > 0) {
        lines.push(
          `  - 风险提示: ${context.feasibility.riskFactors.join('; ')}`,
        )
      }
      lines.push(``)
    }

    if (context.draftPlan) {
      lines.push(
        `【📋 中书省拟旨与门下省审议 (共 ${context.reviewHistory.length} 轮)】`,
      )
      lines.push(`  - 可行性论证: ${context.draftPlan.feasibility}`)
      lines.push(`  - 完备性论证: ${context.draftPlan.completeness}`)
      lines.push(
        `  - 安全与回滚方案: ${context.draftPlan.systemRiskAndRollback}`,
      )
      if (context.zhenguoVerdict) {
        lines.push(
          `  - 镇国公裁决: ${context.zhenguoVerdict.approved ? '准奏' : '驳回'} (${context.zhenguoVerdict.notes ?? context.zhenguoVerdict.vetoReason ?? '无'})`,
        )
      }
      lines.push(``)

      lines.push(`【⚙️ 尚书省六部分工与执行结果】`)
      for (const st of context.draftPlan.subtasks) {
        const artifact = context.execution?.artifacts.find(
          a => a.subtaskId === st.id,
        )
        const statusMark = artifact
          ? artifact.status === 'success'
            ? '✅'
            : '❌'
          : '⏳'
        lines.push(`  ${statusMark} [${st.dept}] ${st.title}`)
        if (artifact?.output) {
          lines.push(`     └─ 产出: ${artifact.output}`)
        }
      }
      lines.push(``)
    }

    if (context.finalVerdict) {
      lines.push(`【⚖️ 御史台终审会签】`)
      lines.push(`  - 凭证号: ${context.finalVerdict.certId ?? '无'}`)
      lines.push(
        `  - 审议裁定: ${context.finalVerdict.accepted ? '合规通过准奏' : '终审驳回'}`,
      )
      lines.push(`  - 结语: ${context.finalVerdict.summary}`)
    }

    return lines.join('\n')
  }
}
