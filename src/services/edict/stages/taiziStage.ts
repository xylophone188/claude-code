import type { TaskComplexity, TaskSpec } from '../types.js'

export interface TaiziDecision {
  isTask: boolean
  spec?: TaskSpec
  directResponse?: string
}

/**
 * 太子阶段：负责 0-Token 快速拦截、闲聊判定及结构化任务卡创建
 */
export async function taiziStage(
  input: string,
  options?: { defaultPriority?: TaskSpec['priority'] },
): Promise<TaiziDecision> {
  const trimmed = input.trim()

  // 1. 简单问答/闲聊判定
  if (/^(你好|在吗|hi|hello|早上好|晚上好)$/i.test(trimmed)) {
    return {
      isTask: false,
      directResponse: '本宫在，请问有何吩咐？',
    }
  }

  // 2. 复杂度判定
  let complexity: TaskComplexity = 'medium'
  if (trimmed.length < 20 && !/(开发|重构|部署|设计|架构)/.test(trimmed)) {
    complexity = 'simple'
  } else if (trimmed.length > 100 || /(架构|重构|跨系统|流水线|安全)/.test(trimmed)) {
    complexity = 'complex'
  }

  // 3. 构建强类型任务 Spec
  const spec: TaskSpec = {
    taskId: `edict-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    title: trimmed.slice(0, 40),
    description: trimmed,
    priority: options?.defaultPriority ?? '中',
    complexity,
    createdAt: Date.now(),
  }

  return {
    isTask: true,
    spec,
  }
}
