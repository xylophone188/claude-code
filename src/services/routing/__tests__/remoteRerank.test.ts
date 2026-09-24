import { describe, it, expect, afterEach } from 'bun:test'
import {
  rerankViaGitee,
  planRerankSlices,
  type RemoteRerankCandidate,
} from '../remoteRerank.js'
import { GiteeKeyRotator } from '../giteePolicy.js'

describe('remoteRerank / planning', () => {
  it('plans a single slice when below free limit', () => {
    expect(planRerankSlices(20).sliceCount).toBe(1)
  })

  it('plans multiple slices when above free limit', () => {
    expect(planRerankSlices(50).sliceCount).toBe(2) // 25 + 25
  })

  it('plans 0 slices for 0 candidates', () => {
    expect(planRerankSlices(0).sliceCount).toBe(0)
  })
})

describe('remoteRerank / call gating', () => {
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  it('refuses non-whitelisted models and returns neutral scores', async () => {
    const candidates: RemoteRerankCandidate[] = [{ text: 'a' }, { text: 'b' }]
    const result = await rerankViaGitee('q', candidates, 'gpt-4', {
      keyRotator: new GiteeKeyRotator(['k']),
    })
    expect(result.ranked.length).toBe(2)
    expect(result.ranked.every(r => r.score === 0)).toBe(true)
    expect(result.sliceCount).toBe(0)
  })

  it('slices + reranks across batches with global min-max normalization', async () => {
    let callCount = 0
    globalThis.fetch = (async (
      _url: string | URL | Request,
      init?: RequestInit,
    ) => {
      callCount++
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        documents: string[]
      }
      // Score = text length (longer = higher)
      const results = body.documents.map((doc, i) => ({
        index: i,
        relevance_score: doc.length,
      }))
      return new Response(JSON.stringify({ results }), { status: 200 })
    }) as unknown as typeof fetch

    // 30 candidates of varying length; first slice gets 25, second slice 5
    const candidates: RemoteRerankCandidate[] = Array.from(
      { length: 30 },
      (_, i) => ({ text: 'x'.repeat(i + 1) }),
    )
    const result = await rerankViaGitee('q', candidates, 'bge-reranker-large', {
      keyRotator: new GiteeKeyRotator(['k1']),
    })
    expect(result.sliceCount).toBe(2)
    expect(result.failedSlices).toBe(0)
    expect(result.ranked.length).toBe(30)
    expect(callCount).toBe(2)
    // The longest text (i=29, length=30) should be ranked first after normalization
    expect(result.ranked[0]?.index).toBe(29)
    // Top score should be 1 (max), bottom score should be 0 (min)
    expect(result.ranked[0]?.score).toBeCloseTo(1, 6)
    expect(result.ranked[result.ranked.length - 1]?.score).toBeCloseTo(0, 6)
  })

  it('marks failed slices and assigns 0 score to them', async () => {
    let callCount = 0
    globalThis.fetch = (async () => {
      callCount++
      if (callCount === 1) {
        return new Response('error', { status: 500 })
      }
      const results = [{ index: 0, relevance_score: 0.9 }]
      return new Response(JSON.stringify({ results }), { status: 200 })
    }) as unknown as typeof fetch

    const candidates: RemoteRerankCandidate[] = Array.from(
      { length: 30 },
      (_, i) => ({ text: `t${i}` }),
    )
    const result = await rerankViaGitee('q', candidates, 'bge-reranker-large', {
      keyRotator: new GiteeKeyRotator(['k1']),
    })
    expect(result.sliceCount).toBe(2)
    expect(result.failedSlices).toBe(1)
  })
})
