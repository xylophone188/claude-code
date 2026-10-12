import type { EdictDraftPlan, FeasibilityReport, TaskSpec } from '../types.js'

/**
 * 丞相/翰林阶段：依赖评估与可行性检查
 */
export async function chengxiangStage(
  spec: TaskSpec,
): Promise<FeasibilityReport> {
  const requiresInfra = /(部署|服务|docker|systemd|端口)/.test(spec.description)
  const dependencies: string[] = []
  if (requiresInfra) dependencies.push('systemd', 'network')
  if (/(数据库|存储|pg|redis)/.test(spec.description)) {
    dependencies.push('postgres', 'redis')
  }

  return {
    feasible: true,
    dependencies,
    estimatedSteps: spec.complexity === 'complex' ? 5 : spec.complexity === 'medium' ? 3 : 1,
    riskFactors: requiresInfra ? ['系统运维操作需可逆'] : [],
  }
}

/**
 * 中书省阶段：起草方案，严格输出四维清单与六部拆解
 */
export async function zhongshuStage(
  spec: TaskSpec,
  feasibility: FeasibilityReport,
  round: number,
  feedback?: string[],
): Promise<EdictDraftPlan> {
  const hasSystemRisk = /(rm -rf|drop table|覆盖系统|格式化)/.test(spec.description)

  return {
    feasibility: `依赖项 [${feasibility.dependencies.join(', ') || '无'}] 已就绪，可行。`,
    completeness: `覆盖目标: ${spec.title}。`,
    systemRiskAndRollback: hasSystemRisk
      ? '检测到潜在危险系统操作，必须提供可逆脚本并人工确认。'
      : '常规代码/任务执行，无需不可逆回滚。',
    hasSystemRisk,
    subtasks: [
      {
        id: `subtask-1`,
        dept: '工部',
        title: '核心功能实现与代码构建',
        description: spec.description,
        requiredTools: ['Edit', 'Write', 'Bash'],
      },
      {
        id: `subtask-2`,
        dept: '刑部',
        title: '自动化测试与验收',
        description: '执行单元测试与 lint 确保无回归',
        requiredTools: ['Bash'],
      },
    ],
  }
}
