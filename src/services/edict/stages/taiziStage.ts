import type { TaskComplexity, TaskSpec } from '../types.js'

export interface TaiziDecision {
  isTask: boolean
  spec?: TaskSpec
  directResponse?: string
}

/**
 * 太子阶段：负责 0-Token 快速拦截、闲聊/简单问答判定及结构化任务卡创建
 */
export async function taiziStage(
  input: string,
  options?: { defaultPriority?: TaskSpec['priority'] },
): Promise<TaiziDecision> {
  const trimmed = input.trim()

  // 1. 0-Token 快速拦截：简单问答/闲聊判定
  if (/^(你好|在吗|hi|hello|hey|早上好|晚上好|中午好|你是谁|ping)$/i.test(trimmed)) {
    return {
      isTask: false,
      directResponse: '本宫在，请问有何吩咐？三省六部流水线已就绪，随时可拟旨派发任务。',
    }
  }

  if (/^(清屏|清除|clear)$/i.test(trimmed)) {
    return {
      isTask: false,
      directResponse: '会话已清屏。',
    }
  }

  if (/^(帮助|help|\/help)$/i.test(trimmed)) {
    return {
      isTask: false,
      directResponse:
        '📜 【Edict 三省六部工作流帮助】\n' +
        '输入具体工程任务（例如“构建并测试认证模块”），将自动触发确定性流水线：\n' +
        '1. 🤴 太子分流：快速拦截与意图 Spec 化\n' +
        '2. 🏛️ 丞相评估：技术栈与依赖可行性评估\n' +
        '3. 📋 中书拟旨：四维清单拟定与六部分工拆解\n' +
        '4. 🔍 门下审议：多轮严格挑刺反思（重大风险镇国公裁决）\n' +
        '5. ⚙️ 尚书派发与六部执行：工/兵/户/礼/刑/吏协同作业\n' +
        '6. ⚖️ 御史台终审：合规留痕并完成准奏归档。',
    }
  }

  // 2. 领域识别
  let domain: TaskSpec['domain'] = 'general'
  if (/(前端|ui|css|html|react|vue|web|页面|样式)/i.test(trimmed)) {
    domain = 'frontend'
  } else if (/(后端|api|路由|服务端|controller|service|sql|pg|redis)/i.test(trimmed)) {
    domain = 'backend'
  } else if (/(部署|docker|systemd|k8s|ci|cd|nginx|端口|网络)/i.test(trimmed)) {
    domain = 'devops'
  } else if (/(安全|漏洞|鉴权|权限|token|加密|防御|audit|防火墙)/i.test(trimmed)) {
    domain = 'security'
  } else if (/(集群|分布式|节点|中间件|网关)/i.test(trimmed)) {
    domain = 'infra'
  }

  // 3. 复杂度判定
  let complexity: TaskComplexity = 'medium'
  if (trimmed.length < 25 && !/(开发|重构|部署|设计|架构|迁移|流水线)/i.test(trimmed)) {
    complexity = 'simple'
  } else if (trimmed.length > 80 || /(架构|重构|跨系统|流水线|安全|高可用|集群|多阶段)/i.test(trimmed)) {
    complexity = 'complex'
  }

  // 4. 构建强类型任务 Spec
  const spec: TaskSpec = {
    taskId: `edict-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    title: trimmed.slice(0, 60),
    description: trimmed,
    priority: options?.defaultPriority ?? (complexity === 'complex' ? '高' : '中'),
    complexity,
    domain,
    createdAt: Date.now(),
  }

  return {
    isTask: true,
    spec,
  }
}

