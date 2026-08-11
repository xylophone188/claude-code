/**
 * CCB intent-routing orchestration layer.
 *
 * Provides a single PURE orchestration entry point
 * that builds on advisor.routeIntent (L1 keyword heuristic) and resolve.resolveModel
 * (combo/model resolution). No network, no DB, no global mutable state beyond the
 * pluggable L2 classifier hook.
 */

import type { CCBRoutingCombo } from './types.js'
import { resolveModel } from './resolve.js'
import {
  routeIntent,
  DEFAULT_ADVISOR_TIERS,
  type AdvisorConfig,
} from './advisor.js'

export type IntentKind = 'advisory' | 'work' | 'advisory-review'
export type Confidence = 'high' | 'medium' | 'low'

export interface IntentClassification {
  intent: IntentKind
  confidence: Confidence
  reason: string
}

export interface AdvisoryRoute {
  model: string
  tier?: string
}

export interface FullRoute extends AdvisoryRoute {
  combo?: string
  strategy?: string
}

// ─── L1 scoring (independent reimplementation of advisor.ts signal style) ───

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

/**
 * Classify a prompt into an intent with a confidence + reason.
 * Independent of advisor.ts internals (re-implements the simple scoring).
 */
export function classifyIntent(prompt: string): IntentClassification {
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
  if (codeBlockCount >= 2) workScore += 3

  if (
    text.length > 500 &&
    (text.includes('npm') ||
      text.includes('pip') ||
      text.includes('cargo') ||
      text.includes('docker'))
  ) {
    workScore += 2
  }

  if (
    text.length < 200 &&
    (text.includes('?') ||
      text.includes('？') ||
      text.includes('什么') ||
      text.includes('如何'))
  ) {
    advisoryScore += 1
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
 * Delegate advisory/work routing to advisor.routeIntent (L1 keyword heuristic).
 */
export function routeAdvisoryIntent(
  prompt: string,
  config?: AdvisorConfig,
): AdvisoryRoute {
  return routeIntent(prompt, config)
}

// ─── Pluggable L2 classifier hook (default passthrough) ───

export type L2Classifier = (prompt: string) => 'advisory' | 'work'

let l2Classifier: L2Classifier | null = null

/**
 * Register (or clear with null) a pluggable L2 classifier used by routeFull as a
 * tiebreaker when L1 confidence is low. Defaults to null (passthrough).
 */
export function setL2Classifier(fn: L2Classifier | null): void {
  l2Classifier = fn
}

function routeViaTiers(
  intent: 'advisory' | 'work',
  config?: AdvisorConfig,
): AdvisoryRoute {
  const tiers =
    config?.tiers && config.tiers.length > 0
      ? config.tiers
      : DEFAULT_ADVISOR_TIERS
  const tier = intent === 'work' ? tiers[tiers.length - 1] : tiers[0]
  return { model: tier.models[0], tier: tier.name }
}

/**
 * Produce a full routing decision:
 *   - If the prompt resolves (via resolve.resolveModel) to a combo, return the
 *     combo's first model plus combo name + strategy.
 *   - Otherwise delegate to advisor.routeIntent. When the L1 confidence is low and
 *     an L2 classifier is set, consult it as a tiebreaker between advisory/work.
 */
export function routeFull(prompt: string, config?: AdvisorConfig): FullRoute {
  const resolved = resolveModel(prompt)
  if (resolved && 'combo' in resolved) {
    const combo: CCBRoutingCombo = resolved.combo
    return {
      model: combo.models[0],
      combo: combo.name,
      strategy: combo.strategy,
    }
  }

  const base = routeIntent(prompt, config)

  if (l2Classifier && classifyIntent(prompt).confidence === 'low') {
    const l2 = l2Classifier(prompt)
    return routeViaTiers(l2, config)
  }

  return base
}
