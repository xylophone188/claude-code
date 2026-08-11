/**
 * ccbRouting / advisor — config-injectable intent router + intelligence upgrade chain.
 *
 * Pure TS, synchronous, NO network, NO SQLite/DB.
 *
 * Ports the relevant logic from ccb:
 *   - src/shared/constants/advisorMode.js  (ADVISOR_VIRTUAL_MODEL, ADVISOR_COMBO_NAME, isReservedAdvisorComboName)
 *   - src/sse/services/advisorLayer.js      (DEFAULT_ADVISOR_TIERS, QUOTA_TARGET_PER_HOUR)
 *   - open-sse/services/advisor.js          (TIER-1 heuristic classification rules)
 *   - src/sse/services/providerTiers.js      (model tiers structure)
 *
 * NOTE: The embedding (L2) and LLM (L3) classification layers are intentionally
 * omitted. Only the TIER-1 keyword heuristics are ported.
 */

export const ADVISOR_VIRTUAL_MODEL = 'advisor'
export const ADVISOR_COMBO_NAME = 'advisor-combo'

/** Mirrors isReservedAdvisorComboName: reserves the bare "advisor" name. */
export function isReservedAdvisorName(name: string): boolean {
  return (
    typeof name === 'string' &&
    name.trim().toLowerCase() === ADVISOR_VIRTUAL_MODEL
  )
}

export interface AdvisorTier {
  name: string
  models: string[]
}

/** Default intelligence upgrade chain (ports advisorLayer.js DEFAULT_ADVISOR_TIERS / providerTiers.js ADVISOR_MODELS). */
export const DEFAULT_ADVISOR_TIERS: AdvisorTier[] = [
  { name: 'frontier', models: ['openai/gpt-5.4', 'xai/grok-4'] },
  { name: 'strong', models: ['kimi/kimi-k3', 'deepseek/deepseek-v4-pro'] },
  { name: 'fast', models: ['groq/llama-3.3-70b-versatile'] },
]

export const QUOTA_TARGET_PER_HOUR = 5

export interface AdvisorConfig {
  tiers?: AdvisorTier[]
  quotaTargetPerHour?: number
}

// ─── TIER-1 heuristic classification (ports open-sse/services/advisor.js rules) ───

const ADVISORY_SIGNALS = [
  '研究',
  '分析',
  '方案',
  '架构',
  '设计',
  '对比',
  '评估',
  'research',
  'analyze',
  'architecture',
  'design',
  'compare',
  'best practice',
  'recommend',
  'strategy',
  'review',
  '有没有',
  '怎么实现',
  '哪个好',
  '推荐',
  '最佳实践',
  '思考',
  '讨论',
  '建议',
  '优化方案',
  '技术选型',
  'explain',
  'why',
  'how to',
  'what is',
  'difference',
  '论文',
  'paper',
  '理论',
  '原理',
  'deep dive',
  '规划',
  'roadmap',
  'vision',
  'mission',
]

const WORK_SIGNALS = [
  '写代码',
  '实现',
  '修复',
  '调试',
  '部署',
  '运行',
  'code',
  'implement',
  'fix',
  'debug',
  'deploy',
  'run',
  'build',
  'test',
  'refactor',
  'add feature',
  'update',
  '安装',
  '配置',
  '修改',
  '创建',
  '删除',
  '更新',
  'install',
  'configure',
  'modify',
  'create',
  'delete',
  'git',
  'commit',
  'push',
  'pull',
  'merge',
  'docker',
  'kubernetes',
  'sql',
  'query',
  'api',
  'endpoint',
  'function',
  'class',
  '脚本',
  '自动化',
  '批量',
  '数据处理',
]

const REVIEW_SIGNALS = [
  '审查',
  '审核',
  '评估',
  'diff',
  '修改建议',
  'review',
  'audit',
  'evaluate',
  'check',
  '是否正确',
  '对不对',
  '有没有问题',
  '是否可行',
]

const ADVISORY_WEIGHT = 2
const WORK_WEIGHT = 2
const CODE_BLOCK_BONUS = 3
const TECH_INSTRUCTION_BONUS = 2
const SHORT_QUESTION_BONUS = 1

type IntentKind = 'advisory' | 'work' | 'advisory-review'

interface RuleResult {
  intent: IntentKind
  confidence: 'high' | 'medium' | 'low'
  reason: string
}

function detectIntentByRules(prompt: string): RuleResult {
  const text = (prompt || '').toLowerCase()

  if (!text.trim()) {
    return { intent: 'advisory', confidence: 'low', reason: 'empty prompt' }
  }

  let advisoryScore = 0
  let workScore = 0
  const matchedAdvisory: string[] = []
  const matchedWork: string[] = []

  for (const signal of ADVISORY_SIGNALS) {
    if (text.includes(signal.toLowerCase())) {
      advisoryScore += ADVISORY_WEIGHT
      matchedAdvisory.push(signal)
    }
  }
  for (const signal of WORK_SIGNALS) {
    if (text.includes(signal.toLowerCase())) {
      workScore += WORK_WEIGHT
      matchedWork.push(signal)
    }
  }

  const codeBlockCount = (text.match(/```/g) || []).length
  if (codeBlockCount >= 2) workScore += CODE_BLOCK_BONUS

  if (
    text.length > 500 &&
    (text.includes('npm') ||
      text.includes('pip') ||
      text.includes('cargo') ||
      text.includes('docker'))
  ) {
    workScore += TECH_INSTRUCTION_BONUS
  }

  if (
    text.length < 200 &&
    (text.includes('?') ||
      text.includes('？') ||
      text.includes('什么') ||
      text.includes('如何'))
  ) {
    advisoryScore += SHORT_QUESTION_BONUS
  }

  let reviewScore = 0
  const matchedReview: string[] = []
  for (const signal of REVIEW_SIGNALS) {
    if (text.includes(signal.toLowerCase())) {
      reviewScore += 2
      matchedReview.push(signal)
    }
  }
  const reviewMargin = Math.abs(advisoryScore - reviewScore)
  if (reviewScore > advisoryScore && reviewMargin >= 2) {
    return {
      intent: 'advisory-review',
      confidence: 'high',
      reason: `review signals: ${matchedReview.slice(0, 4).join(', ')}`,
    }
  }

  const margin = Math.abs(advisoryScore - workScore)
  if (advisoryScore > workScore && margin >= 2) {
    return {
      intent: 'advisory',
      confidence: 'high',
      reason: `advisory signals: ${matchedAdvisory.slice(0, 4).join(', ')}`,
    }
  }
  if (workScore > advisoryScore && margin >= 2) {
    return {
      intent: 'work',
      confidence: 'high',
      reason: `work signals: ${matchedWork.slice(0, 4).join(', ')}${codeBlockCount >= 2 ? ' + code blocks' : ''}`,
    }
  }

  const intent: IntentKind = advisoryScore >= workScore ? 'advisory' : 'work'
  return {
    intent,
    confidence: 'low',
    reason: `tie/weak signal (advisory=${advisoryScore}, work=${workScore})`,
  }
}

/**
 * Route a prompt to a model tier.
 *
 * - If the virtual model "advisor" is requested, return the top tier's first model.
 * - Otherwise classify via TIER-1 heuristics and return the first model of the
 *   appropriate tier (advisory / advisory-review -> top tier intelligence chain;
 *   work -> work tier falls back to top tier's first model by default).
 */
export function routeIntent(
  prompt: string,
  config?: AdvisorConfig,
): { model: string; tier?: string } {
  const tiers =
    config?.tiers && config.tiers.length > 0
      ? config.tiers
      : DEFAULT_ADVISOR_TIERS
  const topTier = tiers[0]

  if (isReservedAdvisorName(prompt.trim())) {
    return { model: topTier.models[0], tier: topTier.name }
  }

  const result = detectIntentByRules(prompt)

  // Map intent -> tier within the upgrade chain:
  //   advisory-review / advisory -> highest intelligence (top tier)
  //   work                  -> cheapest fallback (last tier in the chain)
  // The chain is ordered most->least intelligent (advisorLayer.js DEFAULT_ADVISOR_TIERS).
  const tier = result.intent === 'work' ? tiers[tiers.length - 1] : topTier

  return { model: tier.models[0], tier: tier.name }
}
