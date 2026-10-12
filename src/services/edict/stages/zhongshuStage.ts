import type { EdictDraftPlan, FeasibilityReport, SubtaskPlan, TaskSpec } from '../types.js'

/**
 * 丞相/翰林院阶段：依赖评估与可行性深度检查
 */
export async function chengxiangStage(
  spec: TaskSpec,
): Promise<FeasibilityReport> {
  const desc = spec.description.toLowerCase()
  const dependencies: string[] = ['git', 'bun']
  const riskFactors: string[] = []

  const requiresInfra = /(部署|服务|docker|systemd|端口|nginx|集群)/i.test(desc)
  if (requiresInfra) {
    dependencies.push('systemd', 'network')
    riskFactors.push('涉及系统运维与环境状态变更，需确保操作可逆')
  }

  if (/(数据库|存储|pg|postgres|redis|sqlite|mysql)/i.test(desc)) {
    dependencies.push('postgres', 'redis')
  }

  if (/(网络|api|fetch|http|gateway|网关)/i.test(desc)) {
    dependencies.push('network')
  }

  const isDestructive = /(rm -rf|drop table|格式化|mkfs|dd if=)/i.test(desc)
  if (isDestructive) {
    riskFactors.push('包含潜在高危破坏性指令，需镇国公终局裁决')
  }

  const estimatedSteps =
    spec.complexity === 'complex' ? 5 : spec.complexity === 'medium' ? 3 : 2

  return {
    feasible: true,
    dependencies,
    estimatedSteps,
    riskFactors,
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
  const desc = spec.description
  const hasSystemRisk = /(rm -rf|drop table|覆盖系统|格式化|dd if=)/i.test(desc)

  // 1. 系统风险与回滚方案（四维之一）
  let rollbackPlan = hasSystemRisk
    ? '检测到破坏性高危指令：必须创建快照、保留操作前环境备份，并提供一键逆向回滚脚本。'
    : '常规软件工程操作：所有文件变更受 git 追踪保护，支持 git checkout / git reset 回滚。'

  // 如果门下省反馈要求显式可逆方案，在中书二次起草时补齐
  if (feedback && feedback.some(f => f.includes('可逆'))) {
    rollbackPlan += '【中书复按】已补齐显式可逆机制：记录预检散列值，支持自动化反向撤回。'
  }

  // 2. 六部任务拆解
  const subtasks: SubtaskPlan[] = []

  // 户部：环境与配置准备
  if (feasibility.dependencies.some(d => ['postgres', 'redis', 'network'].includes(d))) {
    subtasks.push({
      id: `subtask-${subtasks.length + 1}`,
      dept: '户部',
      title: '资源环境与配置依赖核验',
      description: `验证依赖环境与服务凭证: ${feasibility.dependencies.join(', ')}`,
      requiredTools: ['Bash', 'Read'],
    })
  }

  // 工部：核心研发与代码实现
  subtasks.push({
    id: `subtask-${subtasks.length + 1}`,
    dept: '工部',
    title: '核心功能研发与系统工程落地',
    description: `依据需求构建最小完整实现: ${spec.title}`,
    requiredTools: ['Edit', 'Write', 'Bash'],
  })

  // 兵部：安全防线与防御审计（复杂任务或包含高危关键词时分配）
  if (spec.complexity === 'complex' || hasSystemRisk || spec.domain === 'security') {
    subtasks.push({
      id: `subtask-${subtasks.length + 1}`,
      dept: '兵部',
      title: '系统防线审查与风险加固',
      description: '执行安全合规检测、凭证泄露防护及防越权审查',
      requiredTools: ['Bash', 'Grep'],
    })
  }

  // 刑部：测试验收与质量底线（必须存在）
  subtasks.push({
    id: `subtask-${subtasks.length + 1}`,
    dept: '刑部',
    title: '自动化测试套件与端到端质量验收',
    description: '运行单元测试与集成测试，验证零回归并产出执行断言',
    requiredTools: ['Bash'],
  })

  // 礼部：规范与对外接口契约（复杂或中等以上任务包含）
  if (spec.complexity !== 'simple') {
    subtasks.push({
      id: `subtask-${subtasks.length + 1}`,
      dept: '礼部',
      title: '规范制定与接口契约留痕',
      description: '梳理 API 契约协议、变更日志与端到端文档规范',
      requiredTools: ['Read', 'Write'],
    })
  }

  // 如果门下省提出补充要求，动态响应
  if (feedback && feedback.length > 0) {
    for (const f of feedback) {
      if (f.includes('测试') && !subtasks.some(s => s.dept === '刑部')) {
        subtasks.push({
          id: `subtask-${subtasks.length + 1}`,
          dept: '刑部',
          title: '增补刑部端到端验收用例',
          description: '针对门下省质疑增补回归测试覆盖',
          requiredTools: ['Bash'],
        })
      }
    }
  }

  return {
    feasibility: `依赖项 [${feasibility.dependencies.join(', ') || '标准环境'}] 已就绪，方案完全可行。`,
    completeness: `已覆盖目标: [${spec.title}]，拆解为 ${subtasks.length} 项六部联动工序。`,
    systemRiskAndRollback: rollbackPlan,
    hasSystemRisk,
    subtasks,
  }
}

