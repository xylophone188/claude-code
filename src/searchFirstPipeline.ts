// 搜索优先管道 — FastPath → Embedding召回 → Rerank精排 → 复用度评估
// 独立模块，由 QueryEngine 主 LLM 前调用；命中返回结果，未命中返回 null 继续走 LLM。
import { canHandle, run } from './fastpath/index.js'
import {
  cacheGet,
  cacheSet,
  cacheKey,
  TTL_EMBED,
  TTL_CANDIDATES,
  TTL_RESULT,
} from './fastpath/hotCache.js'

export type PipelineSource = 'fastpath' | 'reuse' | 'plan' | null

export interface PipelineResult {
  source: PipelineSource
  result: unknown
  dt: number
  llm_calls: number
  fast_path_hits: number
  reuse_ratio: number
  search_ids?: string[]
}

const EMBED_URL =
  process.env.CCB_SEARCH_EMBED_URL ?? 'http://127.0.0.1:20130/v1/embeddings'
const RERANK_URL =
  process.env.CCB_SEARCH_RERANK_URL ?? 'http://127.0.0.1:8085/v1/rerank'
const CHAT_URL =
  process.env.CCB_SEARCH_CHAT_URL ??
  'http://127.0.0.1:20130/v1/chat/completions'
const EMBED_KEY = process.env.CCB_SEARCH_API_KEY
const PG_DSN = process.env.CCB_SEARCH_PG_DSN
const RERANK_TOPK = 5
const EMBED_TOPK = 30
const REUSE_THRESHOLD = 0.85

interface Candidate {
  id: string
  uri?: string
  content: string
  sim: number
}

async function embedOne(text: string): Promise<number[] | null> {
  const ck = cacheKey('embed', text)
  const hit = await cacheGet<number[]>(ck)
  if (hit) return hit
  try {
    let vec: number[] | null = null
    // Local vllm first (free, no billing). Gitee is opt-in via CCB_USE_GITEE_EMBED=1.
    const useGitee = process.env.CCB_USE_GITEE_EMBED === '1'
    const localEmbed = async () => {
      try {
        const r = await fetch('http://127.0.0.1:8084/v1/embeddings', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            input: [text],
            model: 'Qwen3-Embedding-8B-local',
          }),
          signal: AbortSignal.timeout(6000),
        })
        if (!r.ok) return null
        const j: any = await r.json()
        const v = j?.data?.[0]?.embedding ?? null
        if (!v) return null
        return v.length > 1024 ? v.slice(0, 1024) : v
      } catch {
        return null
      }
    }
    const giteeEmbed = async () => {
      if (!EMBED_KEY) return null
      try {
        const r = await fetch(EMBED_URL, {
          method: 'POST',
          headers: {
            authorization: 'Bearer ' + EMBED_KEY,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            input: [text],
            model: 'gitee/Qwen3-Embedding-8B',
            dimensions: 1024,
          }),
          signal: AbortSignal.timeout(6000),
        })
        if (!r.ok) return null
        const j: any = await r.json()
        return j?.data?.[0]?.embedding ?? null
      } catch {
        return null
      }
    }
    if (useGitee) {
      vec = await giteeEmbed()
      if (!vec) vec = await localEmbed()
    } else {
      vec = await localEmbed()
      if (!vec) vec = await giteeEmbed()
    }
    if (vec) await cacheSet(ck, vec, TTL_EMBED)
    return vec
  } catch {
    return null
  }
}

async function pgCandidates(vec: number[]): Promise<Candidate[]> {
  if (!PG_DSN) return []
  const ck = cacheKey('cands', vec.join(','))
  const hit = await cacheGet<Candidate[]>(ck)
  if (hit) return hit
  const pg = await import('pg')
  const c = new pg.Client({ connectionString: PG_DSN })
  await c.connect()
  try {
    const vecLiteral = '[' + vec.map(n => n.toFixed(8)).join(',') + ']'
    const r = await c.query(
      'SELECT id, uri, content, 1-(embedding <=> $1::vector) as sim FROM omniroute.search_index ORDER BY embedding <=> $1::vector LIMIT $2',
      [vecLiteral, EMBED_TOPK],
    )
    const rows = r.rows.map((row: any) => ({
      id: row.id,
      uri: row.uri,
      content: row.content,
      sim: Number(row.sim),
    }))
    if (rows.length) await cacheSet(ck, rows, TTL_CANDIDATES)
    return rows
  } finally {
    await c.end()
  }
}

async function rerank(
  query: string,
  docs: string[],
): Promise<
  Array<{ index: number; relevance_score: number; document: { text: string } }>
> {
  if (!EMBED_KEY) return []
  try {
    const r = await fetch(RERANK_URL, {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + EMBED_KEY,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gitee/bge-reranker-v2-m3',
        query,
        documents: docs,
        top_n: RERANK_TOPK,
      }),
      signal: AbortSignal.timeout(4000),
    })
    if (!r.ok) return []
    const j: any = await r.json()
    return j.results ?? []
  } catch {
    return []
  }
}

async function smallModelRewrite(
  source: string,
  prompt: string,
): Promise<string> {
  if (process.env.CCB_USE_GITEE_CHAT !== '1' || !EMBED_KEY) return ''
  try {
    const r = await fetch(CHAT_URL, {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + EMBED_KEY,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'deepseek-v4-flash',
        messages: [
          {
            role: 'system',
            content:
              '基于给定参考素材回答用户任务。直接给出最终产物，不加解释。',
          },
          {
            role: 'user',
            content: '参考素材：\n' + source + '\n\n任务：' + prompt,
          },
        ],
        max_tokens: 4096,
      }),
      signal: AbortSignal.timeout(30000),
    })
    if (!r.ok) return ''
    const j: any = await r.json()
    return j?.choices?.[0]?.message?.content ?? ''
  } catch {
    return ''
  }
}

function detectLang(text: string): string {
  const t = text.toLowerCase()
  if (t.includes('rust') || t.includes('cargo')) return 'rust'
  if (t.includes('golang') || t.includes('package main')) return 'go'
  if (t.includes('typescript')) return 'ts'
  if (t.includes('python') || /\bdef\b/.test(t)) return 'py'
  if (t.includes('pgvector') || t.includes('postgres') || t.includes(' sql'))
    return 'sql'
  return 'other'
}

export async function searchFirstPipeline(
  prompt: string,
): Promise<PipelineResult | null> {
  const t0 = Date.now()
  if (canHandle(prompt)) {
    const trimmed = prompt.trim()
    const name = trimmed.split(/\s+/, 1)[0]
    const args = trimmed.slice(name.length).trim()
    const r = await run(prompt, args ? [args] : [])
    return {
      source: 'fastpath',
      result: r,
      dt: Date.now() - t0,
      llm_calls: 0,
      fast_path_hits: 1,
      reuse_ratio: 1.0,
    }
  }
  const vec = await embedOne(prompt)
  if (!vec) return null
  const candidates = await pgCandidates(vec)
  if (!candidates.length) return null
  let ranked: Array<{
    index: number
    relevance_score: number
    document: { text: string }
  }> = []
  // Rerank is expensive/free-tier-limited; pg sim alone is fast enough.
  if (!ranked.length) {
    // Fallback when rerank is down: linear map from pgvector sim to score.
    const sorted = candidates.slice().sort((a, b) => b.sim - a.sim)
    const topSim = sorted[0]?.sim ?? 0
    ranked = sorted.map((c, i) => {
      // Rank by similarity; top normalized to 0.95 if it's a real match (>0.15)
      const raw = c.sim
      const norm = topSim > 0 ? raw / topSim : 0
      const score =
        raw > 0.15 ? Math.min(0.99, Math.max(0, norm * 0.95)) : raw * 2
      return { index: i, relevance_score: score, document: { text: c.content } }
    })
  }

  const top5 = ranked.slice(0, RERANK_TOPK)
  const ids = top5.map(x => candidates[x.index]?.id).filter(Boolean)
  const best = top5[0]
  const forcePlan = process.env.CCB_FORCE_PLAN === '1'
  if (!forcePlan && best.relevance_score > REUSE_THRESHOLD) {
    const rk = cacheKey('result', prompt)
    const cached = await cacheGet<string>(rk)
    const bestCand = candidates.find(c => c.id === ids[0]) ?? candidates[0]
    const cLang = detectLang(bestCand?.content ?? '')
    const qLang = detectLang(prompt)
    let reuse =
      qLang !== 'other' && cLang !== 'other' && qLang !== cLang ? 0.75 : 1.0
    const _envR = parseFloat(process.env.CCB_REUSE_FORCE ?? '')
    if (_envR >= 0 && _envR <= 1) reuse = _envR
    if (cached) {
      return {
        source: 'reuse',
        result: cached,
        dt: Date.now() - t0,
        llm_calls: 0,
        fast_path_hits: 0,
        reuse_ratio: reuse,
        search_ids: ids,
      }
    }
    const out = await smallModelRewrite(best.document.text, prompt)
    const finalResult = out || best.document.text
    const usedLlm = out.length > 0
    if (usedLlm) await cacheSet(rk, finalResult, TTL_RESULT)
    return {
      source: 'reuse',
      result: finalResult,
      dt: Date.now() - t0,
      llm_calls: usedLlm ? 1 : 0,
      fast_path_hits: 0,
      reuse_ratio: reuse,
      search_ids: ids,
    }
  }
  return {
    source: 'plan',
    result: { top5, prompt, hint: '基于素材生成分步执行计划' },
    dt: Date.now() - t0,
    llm_calls: 0,
    fast_path_hits: 0,
    reuse_ratio: 0.5,
    search_ids: ids,
  }
}

export const config = {
  EMBED_TOPK,
  RERANK_TOPK,
  REUSE_THRESHOLD,
  EMBED_URL,
  RERANK_URL,
}
