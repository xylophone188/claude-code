/**
 * Gitee AI (魔力方舟) 白名单 + 计费 + 保白嫖切片矩阵策略。
 *
 * 严格限定白名单：未授权模型严禁自动探测/测试。白名单内的 Reranker
 * 与 Embedding 模型才能被 remoteEmbeddings / remoteRerank 调用，其它
 * 模型一律拒绝，避免误用扣费。
 *
 * 计费规则（Gitee AI 公开计费，2026 版本）：
 *   - Reranker: 候选 doc ≤ 25 条免费（0 元）；> 25 且 ≤ 200 条按 ¥0.28 / M token
 *   - Embedding: 小批量免费（0 元）；大批量按 ¥0.07 / M token
 *
 * 保白嫖切片：当请求超过 25 条候选 doc 时，系统层自动按 batch ≤ 25 分批
 * 切片，充分利用免费配额实现 0 成本调用；支持双 Key 轮换。
 */

/** Gitee AI Reranker 白名单（6 个，严格限定，不可自动扩展）。 */
export const GITEE_RERANKER_WHITELIST = [
  'bge-reranker-large',
  'Qwen3-Reranker-8B',
  'Qwen3-Reranker-4B',
  'Qwen3-Reranker-0.6B',
  'bce-reranker-base_v1',
  'bge-reranker-v2-m3',
] as const

/** Gitee AI Embedding 白名单（12 个，严格限定，不可自动扩展）。 */
export const GITEE_EMBEDDING_WHITELIST = [
  'Qwen3-VL-Embedding-8B',
  'jina-embeddings-v4',
  'Qwen3-Embedding-8B',
  'Qwen3-Embedding-4B',
  'Qwen3-Embedding-0.6B',
  'all-mpnet-base-v2',
  'bce-embedding-base_v1',
  'jina-clip-v2',
  'jina-clip-v1',
  'bge-m3',
  'bge-small-zh-v1.5',
  'bge-large-zh-v1.5',
] as const

/** 免费档位的候选 doc 上限（超出即触发切片）。 */
export const GITEE_FREE_BATCH_LIMIT = 25

/** 单次请求的最大候选 doc 上限（Gitee API 硬上限 200）。 */
export const GITEE_MAX_BATCH_LIMIT = 200

/** Reranker 计费档位（¥/百万 token）。 */
export const GITEE_RERANKER_PRICE_PER_M = 0.28

/** Embedding 计费档位（¥/百万 token）。 */
export const GITEE_EMBEDDING_PRICE_PER_M = 0.07

/** Gitee API 入口（可被环境变量覆盖）。 */
export const GITEE_DEFAULT_BASE_URL =
  process.env.GITEE_AI_BASE_URL ?? 'https://ai.gitee.com/api/v1'

/** Reranker 类型标识。 */
export type GiteeModelKind = 'reranker' | 'embedding'

/** 白名单判定：未列入白名单的模型一律拒绝调用。 */
export function isGiteeRerankerAllowed(model: string): boolean {
  return (GITEE_RERANKER_WHITELIST as readonly string[]).includes(model)
}

export function isGiteeEmbeddingAllowed(model: string): boolean {
  return (GITEE_EMBEDDING_WHITELIST as readonly string[]).includes(model)
}

/** 统一白名单判定入口，未授权模型返回 false。 */
export function isGiteeModelAllowed(
  model: string,
  kind: GiteeModelKind,
): boolean {
  return kind === 'reranker'
    ? isGiteeRerankerAllowed(model)
    : isGiteeEmbeddingAllowed(model)
}

/** 保白嫖切片：将候选 doc 列表切成若干 batch，每 batch ≤ freeLimit。
 *  超过 maxBatch 的部分被丢弃（API 硬上限）。 */
export function sliceForFreeBatch<T>(
  items: readonly T[],
  freeLimit: number = GITEE_FREE_BATCH_LIMIT,
  maxBatch: number = GITEE_MAX_BATCH_LIMIT,
): T[][] {
  if (items.length === 0) return []
  const limit = Math.min(freeLimit, maxBatch)
  const total = Math.min(items.length, maxBatch)
  const slices: T[][] = []
  for (let i = 0; i < total; i += limit) {
    slices.push(items.slice(i, i + limit))
  }
  return slices
}

/** 估算单次调用的成本（¥）。候选数 ≤ freeLimit 时 0 成本。 */
export function estimateRerankerCost(
  candidateCount: number,
  freeLimit: number = GITEE_FREE_BATCH_LIMIT,
): number {
  if (candidateCount <= freeLimit) return 0
  // 超出免费档位的部分按 ¥0.28 / M token 估算（粗略：每 doc 约 256 token）。
  const billableDocs = candidateCount - freeLimit
  const tokens = (billableDocs * 256) / 1_000_000
  return Number((tokens * GITEE_RERANKER_PRICE_PER_M).toFixed(6))
}

/** Embedding 成本估算：小批量 0 元，大批量按 ¥0.07 / M token。 */
export function estimateEmbeddingCost(
  textCount: number,
  freeLimit: number = GITEE_FREE_BATCH_LIMIT,
): number {
  if (textCount <= freeLimit) return 0
  const billable = textCount - freeLimit
  const tokens = (billable * 256) / 1_000_000
  return Number((tokens * GITEE_EMBEDDING_PRICE_PER_M).toFixed(6))
}

/** 双 Key 轮换器：按 round-robin 在多个 API key 之间轮换，避免单 key 触发限流。 */
export class GiteeKeyRotator {
  private keys: string[]
  private cursor = 0

  constructor(keys: readonly string[]) {
    this.keys = keys.filter(k => typeof k === 'string' && k.length > 0)
    if (this.keys.length === 0) {
      throw new Error('GiteeKeyRotator: at least one API key is required')
    }
  }

  next(): string {
    const key = this.keys[this.cursor]!
    this.cursor = (this.cursor + 1) % this.keys.length
    return key
  }

  get size(): number {
    return this.keys.length
  }

  reset(): void {
    this.cursor = 0
  }
}

/** 从环境变量构造 Key 轮换器（GITEE_AI_KEYS 逗号分隔，或 GITEE_AI_KEY 单值）。 */
export function createGiteeKeyRotatorFromEnv(): GiteeKeyRotator | null {
  const rawMulti = process.env.GITEE_AI_KEYS
  const rawSingle = process.env.GITEE_AI_KEY
  const keys: string[] = []
  if (rawMulti) {
    for (const k of rawMulti.split(',')) {
      const trimmed = k.trim()
      if (trimmed) keys.push(trimmed)
    }
  }
  if (keys.length === 0 && rawSingle) {
    keys.push(rawSingle.trim())
  }
  if (keys.length === 0) return null
  return new GiteeKeyRotator(keys)
}
