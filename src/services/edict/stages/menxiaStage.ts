import type { EdictDraftPlan, ReviewVerdict } from '../types.js'

/**
 * 门下省与镇国公阶段：负责四维审议、系统风险检测与准奏定论
 * 最多 3 轮循环；第 3 轮如无阻断风险则强制准奏。
 */
export async function menxiaStage(
  plan: EdictDraftPlan,
  round: number,
): Promise<ReviewVerdict> {
  const suggestions: string[] = []

  // 1. 系统红线风险审查 (镇国公一票否决权)
  if (plan.hasSystemRisk && !plan.systemRiskAndRollback.includes('可逆')) {
    return {
      approved: false,
      round,
      suggestions: ['必须提供显式可逆方案与回滚命令'],
      vetoReason: '违反系统安全红线：未提供可逆保障',
    }
  }

  // 2. 完整性审查：必须包含测试/质量验收
  const hasQA = plan.subtasks.some(st => st.dept === '刑部')
  if (!hasQA && round < 3) {
    suggestions.push('缺少刑部（测试与验收）子任务规划')
  }

  if (suggestions.length > 0 && round < 3) {
    return {
      approved: false,
      round,
      suggestions,
      vetoReason: '门下省挑刺：方案完整性不足，退回中书修改',
    }
  }

  // 准奏通过
  return {
    approved: true,
    round,
    suggestions: [],
  }
}
