/**
 * Edict (三省六部) 确定性流水线强类型契约
 * 将纯提示词编排转化为 TypeScript 结构化类型定义
 */

export type EdictTaskState =
  | 'Taizi'        // 太子分流
  | 'Chengxiang'   // 丞相/翰林可行性评估
  | 'Zhongshu'     // 中书省拟旨起草
  | 'Menxia'       // 门下省挑刺审议
  | 'Zhenguo'      // 镇国公终局定论
  | 'Assigned'     // 尚书省拆解与派发
  | 'Doing'        // 六部执行
  | 'Review'       // 尚书省初验
  | 'FinalReview'  // 御史台终审
  | 'Done'         // 完成
  | 'Blocked'      // 阻塞/驳回超限

export type TaskComplexity = 'simple' | 'medium' | 'complex'

export interface TaskSpec {
  taskId: string
  title: string
  description: string
  priority: '低' | '中' | '高' | '紧急'
  complexity: TaskComplexity
  createdAt: number
  metadata?: Record<string, unknown>
}

export interface FeasibilityReport {
  feasible: boolean
  dependencies: string[]
  estimatedSteps: number
  riskFactors: string[]
  reason?: string
}

export interface SubtaskPlan {
  id: string
  dept: '工部' | '兵部' | '户部' | '礼部' | '刑部' | '吏部'
  title: string
  description: string
  requiredTools: string[]
}

export interface EdictDraftPlan {
  feasibility: string
  completeness: string
  systemRiskAndRollback: string
  hasSystemRisk: boolean
  subtasks: SubtaskPlan[]
}

export interface ReviewVerdict {
  approved: boolean
  round: number
  suggestions: string[]
  vetoReason?: string
}

export interface ExecutionArtifact {
  subtaskId: string
  dept: string
  status: 'success' | 'failed'
  output: string
  logs: string[]
}

export interface ExecutionResult {
  allPassed: boolean
  artifacts: ExecutionArtifact[]
  preliminaryVerdict: 'passed' | 'rejected'
  rejectionReason?: string
}

export interface PipelineContext {
  spec: TaskSpec
  state: EdictTaskState
  feasibility?: FeasibilityReport
  draftPlan?: EdictDraftPlan
  reviewHistory: ReviewVerdict[]
  execution?: ExecutionResult
  finalVerdict?: {
    accepted: boolean
    summary: string
    auditedAt: number
  }
}
