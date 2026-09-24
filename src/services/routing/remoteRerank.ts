/**
 * Gitee AI 远程 Reranker 客户端：保白嫖切片调用 + 保序合并 + 双 Key 轮换。
 *
 * 调用流程：
 *   1. 校验模型是否在 GITEE_RERANKER_WHITELIST 内（未授权模型直接拒绝）。
 *   2. 按 GITEE_FREE_BATCH_LIMIT 把候选 doc 切片，每片 ≤ 25 条。
 *   3. 各片调用 Gitee AI rerank 接口，使用 KeyRotator 轮换密钥。
 *   4. 按候选原始顺序合并分数（绝对分数按切片归一化以保证跨片可比）。
 *
 * 计费：候选 doc ≤ 25 条免费（0 元）；超出部分按 ¥0.28 / M token。
 */

import {
  GITEE_DEFAULT_BASE_URL,
  GITEE_FREE_BATCH_LIMIT,
  GITEE_MAX_BATCH_LIMIT,
  createGiteeKeyRotatorFromEnv,
  isGiteeRerankerAllowed,
  sliceForFreeBatch,
  type GiteeKeyRotator,
} from './giteePolicy.js'
import { routeError, routeLog } from './stageLog.js'

export interface RemoteRerankCandidate {
  text: string
  /** 可选的初始元数据，会原样透传到结果中。 */
  meta?: unknown
}

export interface RemoteRerankResultItem {
  /** 原候选在输入列表中的下标。 */
  index: number
  /** 归一化后的 0..1 相关性分数（跨切片可比）。 */
  score: number
  /** 原候选文本。 */
  text: string
  meta?: unknown
}

export interface RemoteRerankResult {
  /** 按分数降序排序后的候选列表。 */
  ranked: RemoteRerankResultItem[]
  /** 实际调用的模型名。 */
  model: string
  /** 切片数量。 */
  sliceCount: number
  /** 失败的切片数量。 */
  failedSlices: number
}

const RERANK_TIMEOUT_MS = 15_000

interface GiteeRerankResponse {
  results?: Array<{ index?: number; relevance_score?: number; score?: number }>
  error?: { message?: string }
}

/** 单切片调用：返回该切片内每个候选的相关性分数。 */
async function callRerankSlice(
  baseUrl: string,
  apiKey: string,
  model: string,
  query: string,
  documents: string[],
  signal: AbortSignal,
): Promise<number[]> {
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/rerank`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      query,
      documents,
    }),
    signal,
  })
  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    throw new Error(`Gitee rerank HTTP ${res.status}: ${errText.slice(0, 200)}`)
  }
  const payload = (await res.json()) as GiteeRerankResponse
  if (payload.error) {
    throw new Error(`Gitee rerank error: ${payload.error.message ?? 'unknown'}`)
  }
  if (!Array.isArray(payload.results)) {
    throw new Error('Gitee rerank response missing results array')
  }
  // 按 index 重建与 documents 顺序一致的分数数组
  const scores = new Array<number>(documents.length).fill(0)
  for (const item of payload.results) {
    const idx = typeof item.index === 'number' ? item.index : -1
    if (idx < 0 || idx >= documents.length) continue
    const score =
      typeof item.relevance_score === 'number'
        ? item.relevance_score
        : typeof item.score === 'number'
          ? item.score
          : 0
    scores[idx] = score
  }
  return scores
}

/** 主入口：对候选 doc 列表做 rerank，返回按相关性降序排序的结果。 */
export async function rerankViaGitee(
  query: string,
  candidates: readonly RemoteRerankCandidate[],
  model: string,
  options: {
    baseUrl?: string
    keyRotator?: GiteeKeyRotator
    signal?: AbortSignal
  } = {},
): Promise<RemoteRerankResult> {
  const baseUrl = options.baseUrl ?? GITEE_DEFAULT_BASE_URL
  const modelAllowed = isGiteeRerankerAllowed(model)
  if (!modelAllowed) {
    routeError('gitee', 'rerank model not whitelisted, refusing to call', model)
    return {
      ranked: candidates.map((c, index) => ({
        index,
        score: 0,
        text: c.text,
        ...(c.meta !== undefined ? { meta: c.meta } : {}),
      })),
      model,
      sliceCount: 0,
      failedSlices: 0,
    }
  }
  const rotator = options.keyRotator ?? createGiteeKeyRotatorFromEnv() ?? null
  if (!rotator) {
    routeError('gitee', 'rerank API key not configured', '')
    return {
      ranked: candidates.map((c, index) => ({
        index,
        score: 0,
        text: c.text,
        ...(c.meta !== undefined ? { meta: c.meta } : {}),
      })),
      model,
      sliceCount: 0,
      failedSlices: 0,
    }
  }

  const truncated = candidates.slice(0, GITEE_MAX_BATCH_LIMIT)
  const slices = sliceForFreeBatch(truncated)
  if (slices.length === 0) {
    return { ranked: [], model, sliceCount: 0, failedSlices: 0 }
  }

  const sliceScores: number[][] = Array.from(
    { length: slices.length },
    () => [],
  )
  let failedSlices = 0
  await Promise.all(
    slices.map(async (slice, idx) => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), RERANK_TIMEOUT_MS)
      if (options.signal) {
        if (options.signal.aborted) controller.abort()
        else options.signal.addEventListener('abort', () => controller.abort())
      }
      try {
        const apiKey = rotator.next()
        const docs = slice.map(c => c.text)
        sliceScores[idx] = await callRerankSlice(
          baseUrl,
          apiKey,
          model,
          query,
          docs,
          controller.signal,
        )
        routeLog(
          'gitee',
          `rerank slice ${idx + 1}/${slices.length} ok n=${slice.length}`,
        )
      } catch (error) {
        failedSlices++
        routeError(
          'gitee',
          `rerank slice ${idx + 1}/${slices.length} failed`,
          String(error),
        )
        sliceScores[idx] = slice.map(() => 0)
      } finally {
        clearTimeout(timer)
      }
    }),
  )

  // 合并分数 + 按 min-max 归一化（跨切片可比）
  const merged: Array<{
    index: number
    rawScore: number
    text: string
    meta?: unknown
  }> = []
  let globalOffset = 0
  for (let s = 0; s < slices.length; s++) {
    const scores = sliceScores[s] ?? []
    const slice = slices[s] ?? []
    for (let i = 0; i < slice.length; i++) {
      const c = slice[i]!
      merged.push({
        index: globalOffset + i,
        rawScore: scores[i] ?? 0,
        text: c.text,
        ...(c.meta !== undefined ? { meta: c.meta } : {}),
      })
    }
    globalOffset += slice.length
  }

  // 全局 min-max 归一化，避免某切片整体偏高/偏低导致跨片失真
  const rawScores = merged.map(m => m.rawScore)
  const min = rawScores.length ? Math.min(...rawScores) : 0
  const max = rawScores.length ? Math.max(...rawScores) : 0
  const range = max - min
  const ranked = merged
    .map(m => ({
      index: m.index,
      score: range > 0 ? (m.rawScore - min) / range : 0,
      text: m.text,
      ...(m.meta !== undefined ? { meta: m.meta } : {}),
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index)

  return {
    ranked,
    model,
    sliceCount: slices.length,
    failedSlices,
  }
}

/** 同步工具：根据候选数量预估切片数与成本（不发起网络请求）。 */
export function planRerankSlices(candidateCount: number): {
  sliceCount: number
  freeLimit: number
  maxBatch: number
} {
  const slices = sliceForFreeBatch(
    Array.from(
      { length: Math.min(candidateCount, GITEE_MAX_BATCH_LIMIT) },
      () => '',
    ),
  )
  return {
    sliceCount: slices.length,
    freeLimit: GITEE_FREE_BATCH_LIMIT,
    maxBatch: GITEE_MAX_BATCH_LIMIT,
  }
}
