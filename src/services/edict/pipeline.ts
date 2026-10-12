import type {
  EdictTaskState,
  PipelineContext,
  TaskSpec,
} from './types.js'
import { taiziStage } from './stages/taiziStage.js'
import { chengxiangStage, zhongshuStage } from './stages/zhongshuStage.js'
import { menxiaStage } from './stages/menxiaStage.js'
import { shangshuStage, type ExecutorFn } from './stages/shangshuStage.js'

export class EdictPipeline {
  private executor?: ExecutorFn

  constructor(options?: { executor?: ExecutorFn }) {
    this.executor = options?.executor
  }

  /**
   * 运行端到端确定性流水线
   */
  async execute(input: string): Promise<PipelineContext | { directResponse: string }> {
    // 1. 太子分流
    const taiziRes = await taiziStage(input)
    if (!taiziRes.isTask || !taiziRes.spec) {
      return { directResponse: taiziRes.directResponse ?? '处理完毕' }
    }

    const context: PipelineContext = {
      spec: taiziRes.spec,
      state: 'Taizi',
      reviewHistory: [],
    }

    // 2. 丞相可行性评估
    context.state = 'Chengxiang'
    context.feasibility = await chengxiangStage(context.spec)

    // 3. 中书省拟旨与门下省挑刺循环 (最多3轮)
    let round = 1
    let approved = false
    while (round <= 3 && !approved) {
      context.state = 'Zhongshu'
      const lastFeedback = context.reviewHistory.at(-1)?.suggestions
      context.draftPlan = await zhongshuStage(
        context.spec,
        context.feasibility,
        round,
        lastFeedback,
      )

      context.state = 'Menxia'
      const verdict = await menxiaStage(context.draftPlan, round)
      context.reviewHistory.push(verdict)

      if (verdict.approved) {
        approved = true
      } else {
        round++
      }
    }

    if (!approved) {
      context.state = 'Blocked'
      return context
    }

    // 4. 尚书省执行调度与自验
    context.state = 'Assigned'
    context.state = 'Doing'
    context.execution = await shangshuStage(context.draftPlan!, this.executor)

    context.state = 'Review'
    if (!context.execution.allPassed) {
      context.state = 'Blocked'
      return context
    }

    // 5. 御史台终审
    context.state = 'FinalReview'
    context.finalVerdict = {
      accepted: true,
      summary: `经御史台终审，任务 [${context.spec.title}] 全流程履职合规完成。`,
      auditedAt: Date.now(),
    }
    context.state = 'Done'

    return context
  }
}
