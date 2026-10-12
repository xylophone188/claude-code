import type { EdictDraftPlan, ExecutionArtifact, ExecutionResult } from '../types.js'

export type ExecutorFn = (subtaskId: string, dept: string) => Promise<{ success: boolean; output: string }>

/**
 * 尚书省阶段：拆分子任务派发执行，并执行首轮验收自检
 */
export async function shangshuStage(
  plan: EdictDraftPlan,
  executor?: ExecutorFn,
): Promise<ExecutionResult> {
  const artifacts: ExecutionArtifact[] = []
  let allPassed = true

  for (const st of plan.subtasks) {
    let output = '执行成功'
    let success = true

    if (executor) {
      const res = await executor(st.id, st.dept)
      success = res.success
      output = res.output
    }

    if (!success) allPassed = false

    artifacts.push({
      subtaskId: st.id,
      dept: st.dept,
      status: success ? 'success' : 'failed',
      output,
      logs: [`[${st.dept}] ${st.title} -> ${success ? 'OK' : 'FAIL'}`],
    })
  }

  return {
    allPassed,
    artifacts,
    preliminaryVerdict: allPassed ? 'passed' : 'rejected',
    rejectionReason: allPassed ? undefined : '尚书省自验不通过：部分子任务执行失败',
  }
}
