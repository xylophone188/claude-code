import type { EdictDraftPlan, TaskSpec, ZhenguoVerdict } from '../types.js'

/**
 * 镇国公阶段：负责重大系统风险、破坏性指令的终局裁决与一票否决权
 */
export async function zhenguoStage(
  spec: TaskSpec,
  plan: EdictDraftPlan,
): Promise<ZhenguoVerdict> {
  // 如果没有系统破坏性风险，镇国公无异议准奏
  if (!plan.hasSystemRisk) {
    return {
      approved: true,
      notes: '镇国公审阅：未检测到高危系统破坏性指令，准予放行。',
    }
  }

  // 严格核查不可逆指令：若描述中包含绝对阻断模式（例如没有确认的格式化或根目录擦除）
  const desc = spec.description.toLowerCase()
  if (/(rm -rf \/|mkfs|dd if=\/dev\/zero)/i.test(desc)) {
    return {
      approved: false,
      vetoReason: '镇国公一票否决：检测到系统根基毁灭性指令，强行阻断流水线。',
      notes: '绝对红线防御生效，任何情况下不得执行全局破坏指令。',
    }
  }

  // 若具备完备的可逆保障与回滚机制，则特许准奏并留痕
  if (plan.systemRiskAndRollback.includes('可逆')) {
    return {
      approved: true,
      notes: '镇国公特裁：检测到高危系统操作，但已有可逆方案与回滚保障，准奏放行。',
    }
  }

  return {
    approved: false,
    vetoReason: '镇国公一票否决：高危系统操作缺乏完备的可逆与回滚保障。',
  }
}
