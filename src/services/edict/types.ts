/**
 * Edict (三省六部) 确定性流水线强类型契约
 * 将纯提示词编排转化为 TypeScript 结构化类型定义
 */

export type EdictTaskState =
  | 'Taizi'        // 太子分流 (0-Token 拦截、意图识别与任务 Spec 创建)
  | 'Chengxiang'   // 丞相/翰林院可行性与依赖评估
  | 'Zhongshu'     // 中书省起草拟旨 (四维清单与六部拆解)
  | 'Menxia'       // 门下省挑刺审议 (四维合规审查与反思驳回)
  | 'Zhenguo'      // 镇国公终局定论 (重大系统风险一票否决)
  | 'Assigned'     // 尚书省拆解与派发 (按部就班分工调度)
  | 'Doing'        // 六部协同执行 (工/兵/户/礼/刑/吏)
  | 'Review'       // 尚书省初验自查
  | 'FinalReview'  // 御史台终审纪检与合规签注
  | 'Done'         // 准奏归档完成
  | 'Blocked'      // 阻塞/驳回超限中断

export type TaskComplexity = 'simple' | 'medium' | 'complex'

export type DepartmentName = '工部' | '兵部' | '户部' | '礼部' | '刑部' | '吏部'

export interface TaskSpec {
  taskId: string
  title: string
  description: string
  priority: '低' | '中' | '高' | '紧急'
  complexity: TaskComplexity
  domain?: 'frontend' | 'backend' | 'devops' | 'security' | 'infra' | 'general'
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
  dept: DepartmentName
  title: string
  description: string
  requiredTools: string[]
  command?: string
  dependencies?: string[]
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

export interface ZhenguoVerdict {
  approved: boolean
  vetoReason?: string
  notes?: string
}

export interface ExecutionArtifact {
  subtaskId: string
  dept: string
  status: 'success' | 'failed'
  output: string
  logs: string[]
  durationMs?: number
}

export interface ExecutionResult {
  allPassed: boolean
  artifacts: ExecutionArtifact[]
  preliminaryVerdict: 'passed' | 'rejected'
  rejectionReason?: string
  totalDurationMs?: number
}

export interface YushitaiVerdict {
  accepted: boolean
  summary: string
  auditedAt: number
  certId?: string
}

export interface PipelineContext {
  spec: TaskSpec
  state: EdictTaskState
  stateHistory: EdictTaskState[]
  startedAt: number
  completedAt?: number
  stageDurations?: Partial<Record<EdictTaskState, number>>
  feasibility?: FeasibilityReport
  draftPlan?: EdictDraftPlan
  reviewHistory: ReviewVerdict[]
  zhenguoVerdict?: ZhenguoVerdict
  execution?: ExecutionResult
  finalVerdict?: YushitaiVerdict
}

export type ExecutorFn = (
  subtaskId: string,
  dept: DepartmentName | string,
  task?: SubtaskPlan,
) => Promise<{ success: boolean; output: string }>

export interface EdictPipelineOptions {
  executor?: ExecutorFn
  onStateChange?: (state: EdictTaskState, context: PipelineContext) => void | Promise<void>
  maxReviewRounds?: number
  defaultPriority?: TaskSpec['priority']
  enableZhenguo?: boolean
}
