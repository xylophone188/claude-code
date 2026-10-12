import type {
  EdictDraftPlan,
  ExecutionResult,
  TaskSpec,
  YushitaiVerdict,
} from '../types.js'

/**
 * 御史台阶段：负责全流程合规复核、执纪留痕与终审发落
 */
export async function yushitaiStage(
  spec: TaskSpec,
  plan: EdictDraftPlan,
  execution: ExecutionResult,
): Promise<YushitaiVerdict> {
  const auditedAt = Date.now()
  const certId = `yushi-cert-${auditedAt.toString(36)}-${Math.random().toString(36).slice(2, 6)}`

  // 1. 核查是否全部通过尚书省自检
  if (!execution.allPassed) {
    return {
      accepted: false,
      summary: `御史台查核未通过：尚书省六部执行记录中存在未决失败项。`,
      auditedAt,
      certId,
    }
  }

  // 2. 核查刑部验收记录
  const qaArtifact = execution.artifacts.find(a => a.dept === '刑部')
  if (!qaArtifact || qaArtifact.status !== 'success') {
    return {
      accepted: false,
      summary: `御史台查核未通过：缺失刑部有效通过的验收凭证。`,
      auditedAt,
      certId,
    }
  }

  // 3. 终审准奏核签
  return {
    accepted: true,
    summary: `经御史台终审会签，任务 [${spec.title}] 经太子分流、丞相评估、中书拟旨、门下挑刺、尚书派发及六部实操，全流程履职合规。敕命准奏归档。`,
    auditedAt,
    certId,
  }
}
