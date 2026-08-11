/**
 * ccbRouting / classification V2 — hybrid L1 (advisor keyword heuristic) + optional L2 (embedding) layer.
 *
 * Pure TS, synchronous, NO network, NO SQLite/DB.
 *
 * - L1 is sourced from advisor.routeIntent (real ccb keyword heuristics + real tier/model ids).
 *   routeIntent only returns { model, tier }, so we:
 *     * map the returned tier back to a coarse intent (work -> last tier, otherwise advisory),
 *     * derive a local L1 confidence from a tiny inline signal re-check (routeIntent does not expose it).
 * - L2 (embedding) is OPTIONAL and injected by the caller via `config.l2`. It is never imported here,
 *   so classification.ts does not depend on embedding.ts (which may not exist in this fork yet).
 *
 * Layer tagging rules:
 *   * no L2 / L2 returns null           -> 'L1'
 *   * L1 confidence 'low' (L2 wins)      -> 'L2'
 *   * L1 vs L2 disagree (L2 wins)        -> 'L1+L2'
 *   * L1 vs L2 agree                     -> 'L1+L2'
 */

import { routeIntent, DEFAULT_ADVISOR_TIERS } from './advisor.js'

export interface ClassificationResult {
  intent: 'advisory' | 'work' | 'advisory-review'
  confidence: 'high' | 'medium' | 'low'
  reason: string
  layer: 'L1' | 'L2' | 'L1+L2'
}

export interface ClassifyV2Config {
  /** Optional L2 embedding classifier. Returns null when the embedding layer has no signal. */
  l2?: (prompt: string) => ('advisory' | 'work') | null
}

// ─── tiny inline L1 confidence re-check (routeIntent does not expose confidence) ───

const ADV_HINTS = [
  '分析',
  '架构',
  '设计',
  '研究',
  '方案',
  '技术选型',
  '对比',
  '评估',
  '推荐',
  'research',
  'analyze',
  'architecture',
  'design',
  'compare',
  'best practice',
  'recommend',
  'strategy',
  'review',
  'explain',
  'why',
  'how to',
  'what is',
  'difference',
  '论文',
  '原理',
  '理论',
  '规划',
  'roadmap',
]

const WRK_HINTS = [
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
  '安装',
  '配置',
  '修改',
  '创建',
  '删除',
  '更新',
  '安装',
  'install',
  'configure',
  'modify',
  'create',
  'delete',
  'git',
  'commit',
  'push',
  'docker',
  'kubernetes',
  'sql',
  'api',
]

function l1Confidence(prompt: string): 'high' | 'medium' | 'low' {
  const text = (prompt || '').toLowerCase()
  if (!text.trim()) return 'low'

  let adv = 0
  let wrk = 0
  for (const h of ADV_HINTS) if (text.includes(h.toLowerCase())) adv++
  for (const h of WRK_HINTS) if (text.includes(h.toLowerCase())) wrk++

  // Mirror routeIntent's margin>=2 "high" rule with a compact local signal count.
  const margin = Math.abs(adv - wrk)
  if (margin >= 2) return 'high'
  if (margin === 1) return 'medium'
  return 'low'
}

/**
 * V2 classification: L1 (advisor.routeIntent) optionally refined by an injected L2 (embedding) layer.
 * Always returns a valid ClassificationResult.
 */
export function classifyV2(
  prompt: string,
  config?: ClassifyV2Config,
): ClassificationResult {
  // ── L1: advisor keyword heuristic via the real routeIntent entrypoint ──
  const routed = routeIntent(prompt)
  const tiers = DEFAULT_ADVISOR_TIERS
  const lastTierName = tiers[tiers.length - 1].name

  // Map routeIntent's returned tier/model back to a coarse intent.
  // routeIntent sends "work" to the last (cheapest) tier; advisory / advisory-review -> top tier.
  const l1Intent: 'advisory' | 'work' =
    routed.tier === lastTierName ? 'work' : 'advisory'

  const l1Conf = l1Confidence(prompt)
  const l1Reason = `L1 routeIntent: tier=${routed.tier ?? '?'}, model=${routed.model} -> ${l1Intent}`

  const l2 = config?.l2

  // No L2 configured, or L2 produced no signal -> pure L1 result.
  if (!l2) {
    return {
      intent: l1Intent,
      confidence: l1Conf,
      reason: l1Reason,
      layer: 'L1',
    }
  }

  const l2Intent = l2(prompt)
  if (l2Intent === null) {
    return {
      intent: l1Intent,
      confidence: l1Conf,
      reason: l1Reason,
      layer: 'L1',
    }
  }

  // L1 confidence too low -> trust L2 outright.
  if (l1Conf === 'low') {
    return {
      intent: l2Intent,
      confidence: l1Conf,
      reason: `${l1Reason}; L2 override (L1 low) -> ${l2Intent}`,
      layer: 'L2',
    }
  }

  // L1 vs L2 disagree -> L2 wins, but both layers contributed.
  if (l1Intent !== l2Intent) {
    return {
      intent: l2Intent,
      confidence: l1Conf,
      reason: `${l1Reason}; L2 disagrees -> ${l2Intent}`,
      layer: 'L1+L2',
    }
  }

  // L1 vs L2 agree -> both layers confirm.
  return {
    intent: l1Intent,
    confidence: l1Conf,
    reason: `${l1Reason}; L2 agrees (${l2Intent})`,
    layer: 'L1+L2',
  }
}
