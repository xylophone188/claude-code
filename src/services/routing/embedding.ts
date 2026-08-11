/**
 * ccbRouting / embedding — offline L2 intent classifier (cheap local embeddings).
 *
 * Pure TS, synchronous, NO network, NO external deps. This is the L2 fallback
 * for ccb's embedding classifier, implemented fully offline:
 *   - deterministic hashing bag-of-words vector (fixed dimension, L2-normalized)
 *   - cosine similarity against two built-in sample centroids
 *
 * NOTE: This intentionally omits any real model/provider. It is text-only.
 */

/** Fixed embedding dimension for the hashing vector. */
export const EMBED_DIM = 64

/** Intent kinds recognized by the embedding classifier. */
export type EmbedIntent = 'advisory' | 'work'

/** Advisory-style sample phrases (bilingual zh/en) used to build the centroid. */
const ADVISORY_PHRASES = [
  '研究一下这个架构方案的可行性',
  '帮我分析一下两种技术的对比和最佳实践',
  '有什么推荐的设计思路吗 discuss the strategy and roadmap',
  'explain the difference between these concepts and why',
  '理论原理 deep dive 论文 paper 怎么实现比较好',
  '评估技术选型 给出优化方案和思考',
  'what is the best practice for this architecture design',
  'review the approach and recommend a strategy',
]

/** Work/code-style sample phrases (bilingual zh/en) used to build the centroid. */
const WORK_PHRASES = [
  '帮我写代码实现这个功能并运行测试',
  '修复这个 bug 并调试 deploy 部署到服务器',
  'implement a function to add feature and run the build',
  '修改配置文件然后 commit push 到 git 仓库',
  'create a docker container and refactor the class',
  '配置 kubernetes 用 sql 查询数据库 debug 脚本',
  'install the package and configure the api endpoint',
  'update the code run the test fix the error',
]

/** Deterministic 32-bit string hash (FNV-1a style, DJB2 variant). */
function hashToken(token: string): number {
  let h = 5381
  for (let i = 0; i < token.length; i++) {
    h = (h * 33 + token.charCodeAt(i)) >>> 0
  }
  return h
}

/**
 * Tokenize on non-word characters (keeps CJK runs as single tokens).
 * Lowercased; splits on whitespace and punctuation but not inside CJK.
 */
function tokenize(text: string): string[] {
  const lower = (text || '').toLowerCase()
  // Match latin/alnum runs and CJK single characters.
  const matches = lower.match(/[a-z0-9]+|[一-鿿]/g)
  return matches ?? []
}

/**
 * Produce a fixed-dimension (EMBED_DIM) bag-of-words / hashing vector from text.
 * Tokens are hashed into buckets; counts are incremented and the result is
 * L2-normalized. Pure and deterministic.
 */
export function embed(text: string): number[] {
  const vec = new Array<number>(EMBED_DIM).fill(0)
  const tokens = tokenize(text)
  for (const tok of tokens) {
    const bucket = hashToken(tok) % EMBED_DIM
    vec[bucket] += 1
  }
  // L2-normalize.
  let norm = 0
  for (const v of vec) norm += v * v
  norm = Math.sqrt(norm)
  if (norm > 0) {
    for (let i = 0; i < vec.length; i++) vec[i] = vec[i] / norm
  }
  return vec
}

/**
 * Cosine similarity between two equal-length vectors in [-1, 1].
 * Returns 0 for degenerate (all-zero) vectors.
 */
export function cosine(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length)
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/** Build a centroid vector by averaging the embeddings of a set of phrases. */
function buildCentroid(phrases: string[]): number[] {
  const acc = new Array<number>(EMBED_DIM).fill(0)
  for (const phrase of phrases) {
    const v = embed(phrase)
    for (let i = 0; i < EMBED_DIM; i++) acc[i] += v[i]
  }
  // L2-normalize the averaged centroid.
  let norm = 0
  for (const v of acc) norm += v * v
  norm = Math.sqrt(norm)
  if (norm > 0) {
    for (let i = 0; i < acc.length; i++) acc[i] = acc[i] / norm
  }
  return acc
}

// Built-in centroids (computed once, module-load time, pure).
const ADVISORY_CENTROID = buildCentroid(ADVISORY_PHRASES)
const WORK_CENTROID = buildCentroid(WORK_PHRASES)

/** Expose the built-in centroid for a given intent kind (for tests). */
export function centroid(kind: EmbedIntent): number[] {
  return kind === 'advisory' ? ADVISORY_CENTROID.slice() : WORK_CENTROID.slice()
}

/**
 * Classify text as 'advisory' or 'work' by comparing embed(text) against the
 * two built-in centroids and returning the closer one via cosine similarity.
 */
export function classifyByEmbedding(text: string): EmbedIntent {
  const v = embed(text)
  const simAdvisory = cosine(v, ADVISORY_CENTROID)
  const simWork = cosine(v, WORK_CENTROID)
  return simAdvisory >= simWork ? 'advisory' : 'work'
}
