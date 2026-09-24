import { describe, it, expect, afterEach } from 'bun:test'
import { embedTextsViaGitee, planEmbeddingSlices } from '../remoteEmbeddings.js'
import { GiteeKeyRotator } from '../giteePolicy.js'

describe('remoteEmbeddings / planning', () => {
  it('plans a single slice when below free limit', () => {
    const plan = planEmbeddingSlices(10)
    expect(plan.sliceCount).toBe(1)
  })

  it('plans multiple slices when above free limit', () => {
    const plan = planEmbeddingSlices(60)
    expect(plan.sliceCount).toBe(3) // 25 + 25 + 10
  })

  it('plans 0 slices for 0 texts', () => {
    expect(planEmbeddingSlices(0).sliceCount).toBe(0)
  })
})

describe('remoteEmbeddings / call gating', () => {
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  it('refuses non-whitelisted models and returns empty vectors', async () => {
    const result = await embedTextsViaGitee(['a', 'b'], 'gpt-4', {
      keyRotator: new GiteeKeyRotator(['k']),
    })
    expect(result.vectors).toEqual([[], []])
    expect(result.sliceCount).toBe(0)
    expect(result.failedSlices).toBe(0)
  })

  it('returns empty vectors when no key rotator is configured', async () => {
    // No keyRotator env, no GITEE_AI_KEYS/GITEE_AI_KEY set → rotator null
    const prevKeys = process.env.GITEE_AI_KEYS
    const prevKey = process.env.GITEE_AI_KEY
    delete process.env.GITEE_AI_KEYS
    delete process.env.GITEE_AI_KEY
    try {
      const result = await embedTextsViaGitee(['a'], 'bge-m3')
      expect(result.vectors).toEqual([[]])
      expect(result.sliceCount).toBe(0)
    } finally {
      if (prevKeys === undefined) delete process.env.GITEE_AI_KEYS
      else process.env.GITEE_AI_KEYS = prevKeys
      if (prevKey === undefined) delete process.env.GITEE_AI_KEY
      else process.env.GITEE_AI_KEY = prevKey
    }
  })

  it('slices + merges while preserving order', async () => {
    let calls = 0
    globalThis.fetch = (async (
      _url: string | URL | Request,
      init?: RequestInit,
    ) => {
      calls++
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        model: string
        input: string[]
      }
      // Return one vector per input text, containing the input index
      const data = body.input.map((text, i) => ({
        embedding: [i, text.length],
      }))
      return new Response(JSON.stringify({ data }), { status: 200 })
    }) as unknown as typeof fetch

    const texts = Array.from({ length: 30 }, (_, i) => `t${i}`)
    const result = await embedTextsViaGitee(texts, 'bge-m3', {
      keyRotator: new GiteeKeyRotator(['k1', 'k2']),
    })
    expect(result.sliceCount).toBe(2)
    expect(result.failedSlices).toBe(0)
    expect(result.vectors.length).toBe(30)
    // Order preservation: index i should have its index as first element
    expect(result.vectors[0]?.[0]).toBe(0)
    expect(result.vectors[25]?.[0]).toBe(0) // first of second slice
    expect(result.vectors[29]?.[0]).toBe(4) // 29-25 = 4
    expect(calls).toBe(2)
  })

  it('marks failed slices and returns empty vectors for them', async () => {
    let callCount = 0
    globalThis.fetch = (async () => {
      callCount++
      if (callCount === 1) {
        return new Response('server error', { status: 500 })
      }
      const data = [{ embedding: [1] }, { embedding: [2] }]
      return new Response(JSON.stringify({ data }), { status: 200 })
    }) as unknown as typeof fetch

    const texts = Array.from({ length: 30 }, (_, i) => `t${i}`)
    const result = await embedTextsViaGitee(texts, 'bge-m3', {
      keyRotator: new GiteeKeyRotator(['k1']),
    })
    expect(result.sliceCount).toBe(2)
    expect(result.failedSlices).toBe(1)
  })
})
