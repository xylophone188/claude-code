import type { EdictDraftPlan, ReviewVerdict } from '../types.js'

/**
 * 门下省阶段：负责四维审议、系统风险检测与严苛反思挑刺
 * 四维审查指标：
 * 1. 可行性 (Feasibility)
 * 2. 完备性 (Completeness)
 * 3. 系统风险与回滚方案 (System Risk & Rollback)
 * 4. 六部协同分工 (Six Ministries Coordination)
 */
export async function menxiaStage(
  plan: EdictDraftPlan,
  round: number,
): Promise<ReviewVerdict> {
  const suggestions: string[] = []

  // 1. 系统红线风险审查 (重大风险必须包含可逆保障，否则一票打回)
  if (plan.hasSystemRisk && !plan.systemRiskAndRollback.includes('可逆')) {
    return {
      approved: false,
      round,
      suggestions: ['必须提供显式可逆方案与回滚命令，严禁不可逆破坏操作'],
      vetoReason: '违反系统安全红线：检测到系统高危操作，但未提供可逆保障方案',
    }
  }

  // 2. 完备性审查：必须包含工部实施与刑部质检
  const hasEngineering = plan.subtasks.some(st => st.dept === '工部')
  if (!hasEngineering && round < 3) {
    suggestions.push('缺少工部核心功能研发与构建子任务')
  }

  const hasQA = plan.subtasks.some(st => st.dept === '刑部')
  if (!hasQA && round < 3) {
    suggestions.push('缺少刑部（测试与验收）子任务规划，无法保证质量底线')
  }

  // 3. 子任务有效性审查
  if (plan.subtasks.length === 0 && round < 3) {
    suggestions.push('六部任务拆解为空，中书拟旨不合格')
  }

  if (suggestions.length > 0 && round < 3) {
    return {
      approved: false,
      round,
      suggestions,
      vetoReason: `门下省第 ${round} 轮挑刺驳回：方案完备性不足，退回中书修改`,
    }
  }

  // 准奏通过
  return {
    approved: true,
    round,
    suggestions: [],
  }
}

