/**
 * Gitee AI 远程 Embedding 客户端：实现保白嫖切片调用 + 保序合并 + 双 Key 轮换。
 *
 * 调用流程：
 *   1. 校验模型是否在 GITEE_EMBEDDING_WHITELIST 内（未授权模型直接拒绝）。
 *   2. 按 GITEE_FREE_BATCH_LIMIT 把输入文本切片，每片 ≤ 25 条。
 *   3. 各片调用 Gitee AI `/v1/embeddings`，使用 KeyRotator 轮换密钥。
 *   4. 按 slice 顺序合并向量，保证调用方下标与返回下标一一对应。
 *
 * 设计原则（二十四字心法）：
 *   - 该用用，不该用不用：未授权模型严禁探测
 *   - 能嫖嫖，好好嫖：充分利用每片 25 条免费配额
 *   - 按其约束合理白嫖：超出硬上限部分丢弃，绝不超发请求
 *   - 拒绝铺张浪费，拒绝空转：失败返回空结果，不重试刷量
 */

import {
  GITEE_DEFAULT_BASE_URL,
  GITEE_FREE_BATCH_LIMIT,
  GITEE_MAX_BATCH_LIMIT,
  createGiteeKeyRotatorFromEnv,
  isGiteeEmbeddingAllowed,
  sliceForFreeBatch,
  type GiteeKeyRotator,
} from './giteePolicy.js'
import { routeError, routeLog } from './stageLog.js'

export interface RemoteEmbeddingResult {
  /** 与输入文本一一对应的向量列表；调用失败的文本返回空数组占位。 */
  vectors: number[][]
  /** 实际调用的模型名。 */
  model: string
  /** 切片数量（便于审计保白嫖切片是否生效）。 */
  sliceCount: number
  /** 失败的切片数量（0 表示全部成功）。 */
  failedSlices: number
}

/** 单次 HTTP 调用 Gitee AI embeddings 接口的超时（毫秒）。 */
const EMBEDDING_TIMEOUT_MS = 15_000

/** 单个切片请求的响应结构（OpenAI 兼容协议）。 */
interface GiteeEmbeddingResponse {
  data?: Array<{ embedding?: number[] }>
  error?: { message?: string }
}

/** 单切片调用：返回该切片的向量数组；失败抛出 Error。 */
async function callEmbeddingSlice(
  baseUrl: string,
  apiKey: string,
  model: string,
  texts: string[],
  signal: AbortSignal,
): Promise<number[][]> {
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/embeddings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, input: texts }),
    signal,
  })
  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    throw new Error(
      `Gitee embedding HTTP ${res.status}: ${errText.slice(0, 200)}`,
    )
  }
  const payload = (await res.json()) as GiteeEmbeddingResponse
  if (payload.error) {
    throw new Error(
      `Gitee embedding error: ${payload.error.message ?? 'unknown'}`,
    )
  }
  if (!Array.isArray(payload.data)) {
    throw new Error('Gitee embedding response missing data array')
  }
  return payload.data.map(item =>
    Array.isArray(item.embedding) ? item.embedding : [],
  )
}

/** 主入口：传入任意数量的文本，返回与输入一一对应的向量。
 *  内部自动按 25 条切片，逐片调用 Gitee AI API，保序合并。
 *  当 keyRotator 或 model 不合法时返回全空向量（不抛出，保证调用方降级）。 */
export async function embedTextsViaGitee(
  texts: readonly string[],
  model: string,
  options: {
    baseUrl?: string
    keyRotator?: GiteeKeyRotator
    signal?: AbortSignal
  } = {},
): Promise<RemoteEmbeddingResult> {
  const baseUrl = options.baseUrl ?? GITEE_DEFAULT_BASE_URL
  const modelAllowed = isGiteeEmbeddingAllowed(model)
  if (!modelAllowed) {
    routeError(
      'gitee',
      'embedding model not whitelisted, refusing to call',
      model,
    )
    return {
      vectors: texts.map(() => []),
      model,
      sliceCount: 0,
      failedSlices: 0,
    }
  }
  const rotator = options.keyRotator ?? createGiteeKeyRotatorFromEnv() ?? null
  if (!rotator) {
    routeError('gitee', 'embedding API key not configured', '')
    return {
      vectors: texts.map(() => []),
      model,
      sliceCount: 0,
      failedSlices: 0,
    }
  }

  const truncated = texts.slice(0, GITEE_MAX_BATCH_LIMIT)
  const slices = sliceForFreeBatch(truncated)
  if (slices.length === 0) {
    return { vectors: [], model, sliceCount: 0, failedSlices: 0 }
  }

  const results: number[][][] = Array.from({ length: slices.length }, () => [])
  let failedSlices = 0
  await Promise.all(
    slices.map(async (slice, idx) => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), EMBEDDING_TIMEOUT_MS)
      // 透传外层 AbortSignal
      if (options.signal) {
        if (options.signal.aborted) controller.abort()
        else options.signal.addEventListener('abort', () => controller.abort())
      }
      try {
        const apiKey = rotator.next()
        const vectors = await callEmbeddingSlice(
          baseUrl,
          apiKey,
          model,
          slice,
          controller.signal,
        )
        results[idx] = vectors
        routeLog(
          'gitee',
          `embedding slice ${idx + 1}/${slices.length} ok n=${slice.length}`,
        )
      } catch (error) {
        failedSlices++
        routeError(
          'gitee',
          `embedding slice ${idx + 1}/${slices.length} failed`,
          String(error),
        )
        results[idx] = slice.map(() => [])
      } finally {
        clearTimeout(timer)
      }
    }),
  )

  // 按切片顺序合并，保证下标与输入一一对应
  const vectors: number[][] = []
  for (const sliceResult of results) {
    for (const vec of sliceResult) {
      vectors.push(vec)
    }
  }

  return {
    vectors,
    model,
    sliceCount: slices.length,
    failedSlices,
  }
}

/** 同步工具：根据输入文本数量预估切片数与成本（不发起网络请求）。 */
export function planEmbeddingSlices(textCount: number): {
  sliceCount: number
  freeLimit: number
  maxBatch: number
} {
  const slices = sliceForFreeBatch(
    Array.from(
      { length: Math.min(textCount, GITEE_MAX_BATCH_LIMIT) },
      () => '',
    ),
  )
  return {
    sliceCount: slices.length,
    freeLimit: GITEE_FREE_BATCH_LIMIT,
    maxBatch: GITEE_MAX_BATCH_LIMIT,
  }
}
