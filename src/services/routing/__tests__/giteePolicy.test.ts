import { describe, it, expect } from 'bun:test'
import {
  GITEE_FREE_BATCH_LIMIT,
  GITEE_MAX_BATCH_LIMIT,
  GITEE_RERANKER_WHITELIST,
  GITEE_EMBEDDING_WHITELIST,
  GiteeKeyRotator,
  createGiteeKeyRotatorFromEnv,
  estimateEmbeddingCost,
  estimateRerankerCost,
  isGiteeEmbeddingAllowed,
  isGiteeModelAllowed,
  isGiteeRerankerAllowed,
  sliceForFreeBatch,
} from '../giteePolicy.js'

describe('giteePolicy / whitelist', () => {
  it('reranker whitelist has exactly 6 entries', () => {
    expect(GITEE_RERANKER_WHITELIST.length).toBe(6)
  })

  it('embedding whitelist has exactly 12 entries', () => {
    expect(GITEE_EMBEDDING_WHITELIST.length).toBe(12)
  })

  it('whitelisted rerankers are allowed', () => {
    expect(isGiteeRerankerAllowed('bge-reranker-large')).toBe(true)
    expect(isGiteeRerankerAllowed('Qwen3-Reranker-8B')).toBe(true)
  })

  it('non-whitelisted models are refused (no auto-probe)', () => {
    expect(isGiteeRerankerAllowed('some-random-model')).toBe(false)
    expect(isGiteeEmbeddingAllowed('gpt-4')).toBe(false)
  })

  it('isGiteeModelAllowed routes by kind', () => {
    expect(isGiteeModelAllowed('bge-m3', 'embedding')).toBe(true)
    expect(isGiteeModelAllowed('bge-m3', 'reranker')).toBe(false)
    expect(isGiteeModelAllowed('bge-reranker-large', 'reranker')).toBe(true)
  })
})

describe('giteePolicy / batching', () => {
  it('slices a list under the free limit into a single batch', () => {
    const slices = sliceForFreeBatch([1, 2, 3])
    expect(slices.length).toBe(1)
    expect(slices[0]).toEqual([1, 2, 3])
  })

  it('slices exactly at the free limit', () => {
    const items = Array.from({ length: GITEE_FREE_BATCH_LIMIT }, (_, i) => i)
    const slices = sliceForFreeBatch(items)
    expect(slices.length).toBe(1)
  })

  it('slices beyond the free limit into multiple batches', () => {
    const items = Array.from(
      { length: GITEE_FREE_BATCH_LIMIT + 5 },
      (_, i) => i,
    )
    const slices = sliceForFreeBatch(items)
    expect(slices.length).toBe(2)
    expect(slices[0]!.length).toBe(GITEE_FREE_BATCH_LIMIT)
    expect(slices[1]!.length).toBe(5)
  })

  it('truncates inputs above the hard max-batch cap', () => {
    const items = Array.from(
      { length: GITEE_MAX_BATCH_LIMIT + 10 },
      (_, i) => i,
    )
    const slices = sliceForFreeBatch(items)
    const total = slices.reduce((sum, s) => sum + s.length, 0)
    expect(total).toBe(GITEE_MAX_BATCH_LIMIT)
  })

  it('empty input produces empty slices', () => {
    expect(sliceForFreeBatch([])).toEqual([])
  })
})

describe('giteePolicy / cost', () => {
  it('free-tier reranker costs 0', () => {
    expect(estimateRerankerCost(25)).toBe(0)
    expect(estimateRerankerCost(10)).toBe(0)
  })

  it('reranker beyond free tier is billed', () => {
    expect(estimateRerankerCost(30)).toBeGreaterThan(0)
  })

  it('free-tier embedding costs 0', () => {
    expect(estimateEmbeddingCost(25)).toBe(0)
  })

  it('embedding beyond free tier is billed', () => {
    expect(estimateEmbeddingCost(30)).toBeGreaterThan(0)
  })
})

describe('giteePolicy / key rotator', () => {
  it('rotates keys in round-robin order', () => {
    const r = new GiteeKeyRotator(['k1', 'k2'])
    expect(r.next()).toBe('k1')
    expect(r.next()).toBe('k2')
    expect(r.next()).toBe('k1')
    expect(r.size).toBe(2)
  })

  it('throws when given no keys', () => {
    expect(() => new GiteeKeyRotator([])).toThrow()
  })

  it('filters empty strings', () => {
    const r = new GiteeKeyRotator(['', 'k1', ''])
    expect(r.size).toBe(1)
    expect(r.next()).toBe('k1')
  })

  it('reset returns the cursor to start', () => {
    const r = new GiteeKeyRotator(['k1', 'k2'])
    r.next()
    r.next()
    r.reset()
    expect(r.next()).toBe('k1')
  })

  it('env-based rotator reads GITEE_AI_KEYS', () => {
    const prev = process.env.GITEE_AI_KEYS
    const prevSingle = process.env.GITEE_AI_KEY
    delete process.env.GITEE_AI_KEY
    process.env.GITEE_AI_KEYS = 'key-a,key-b'
    try {
      const r = createGiteeKeyRotatorFromEnv()
      expect(r).not.toBeNull()
      expect(r!.size).toBe(2)
      expect(r!.next()).toBe('key-a')
    } finally {
      if (prev === undefined) delete process.env.GITEE_AI_KEYS
      else process.env.GITEE_AI_KEYS = prev
      if (prevSingle === undefined) delete process.env.GITEE_AI_KEY
      else process.env.GITEE_AI_KEY = prevSingle
    }
  })

  it('env-based rotator falls back to GITEE_AI_KEY single value', () => {
    const prevKeys = process.env.GITEE_AI_KEYS
    const prev = process.env.GITEE_AI_KEY
    delete process.env.GITEE_AI_KEYS
    try {
      process.env.GITEE_AI_KEY = 'single-key'
      const r = createGiteeKeyRotatorFromEnv()
      expect(r).not.toBeNull()
      expect(r!.size).toBe(1)
      expect(r!.next()).toBe('single-key')
    } finally {
      if (prevKeys === undefined) delete process.env.GITEE_AI_KEYS
      else process.env.GITEE_AI_KEYS = prevKeys
      if (prev === undefined) delete process.env.GITEE_AI_KEY
      else process.env.GITEE_AI_KEY = prev
    }
  })

  it('env-based rotator returns null when no env set', () => {
    const prevKeys = process.env.GITEE_AI_KEYS
    const prev = process.env.GITEE_AI_KEY
    delete process.env.GITEE_AI_KEYS
    delete process.env.GITEE_AI_KEY
    try {
      expect(createGiteeKeyRotatorFromEnv()).toBeNull()
    } finally {
      if (prevKeys === undefined) delete process.env.GITEE_AI_KEYS
      else process.env.GITEE_AI_KEYS = prevKeys
      if (prev === undefined) delete process.env.GITEE_AI_KEY
      else process.env.GITEE_AI_KEY = prev
    }
  })
})
