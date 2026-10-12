import type {
  DepartmentName,
  EdictDraftPlan,
  ExecutionArtifact,
  ExecutionResult,
  ExecutorFn,
  SubtaskPlan,
} from '../types.js'

export type { ExecutorFn }

/**
 * 默认执行器：当未传入外部 executor 时的安全执行实现
 */
async function defaultSubtaskExecutor(
  task: SubtaskPlan,
): Promise<{ success: boolean; output: string }> {
  // 模拟真实六部按职责履职
  return {
    success: true,
    output: `[${task.dept}] 执行完成: ${task.title}`,
  }
}

/**
 * 尚书省阶段：拆分子任务派发六部执行，并执行首轮初验自查
 */
export async function shangshuStage(
  plan: EdictDraftPlan,
  executor?: ExecutorFn,
): Promise<ExecutionResult> {
  const artifacts: ExecutionArtifact[] = []
  let allPassed = true
  const startAll = Date.now()

  for (const st of plan.subtasks) {
    const subtaskStart = Date.now()
    let output = '执行成功'
    let success = true

    try {
      if (executor) {
        const res = await executor(st.id, st.dept, st)
        success = res.success
        output = res.output
      } else {
        const res = await defaultSubtaskExecutor(st)
        success = res.success
        output = res.output
      }
    } catch (err: unknown) {
      success = false
      output = `执行异常: ${err instanceof Error ? err.message : String(err)}`
    }

    const durationMs = Date.now() - subtaskStart
    if (!success) {
      allPassed = false
    }

    artifacts.push({
      subtaskId: st.id,
      dept: st.dept,
      status: success ? 'success' : 'failed',
      output,
      logs: [
        `[${st.dept}] ${st.title} -> ${success ? 'OK' : 'FAIL'} (${durationMs}ms)`,
      ],
      durationMs,
    })
  }

  const totalDurationMs = Date.now() - startAll

  return {
    allPassed,
    artifacts,
    preliminaryVerdict: allPassed ? 'passed' : 'rejected',
    rejectionReason: allPassed ? undefined : '尚书省自验不通过：部分六部子任务执行失败',
    totalDurationMs,
  }
}

