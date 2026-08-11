import { describe, it, expect } from 'bun:test'
import { unifiedResolve, listUnifiedSources } from '../unifiedRouter.js'

describe('unifiedResolve', () => {
  it('resolves a ccbRouting provider/model spec', () => {
    const r = unifiedResolve('openai/gpt-5.4')
    expect(r).toBeDefined()
    expect(r!.kind).toBe('ccbRouting')
    expect(r!.id).toBe('openai')
    expect(r!.model).toBe('gpt-5.4')
    expect(typeof r!.baseUrl).toBe('string')
    expect(r!.baseUrl.length).toBeGreaterThan(0)
  })

  it('resolves the advisor virtual model to its top-tier provider', () => {
    const r = unifiedResolve('advisor')
    expect(r).toBeDefined()
    expect(r!.kind).toBe('advisor')
    expect(r!.id).toBe('openai')
    expect(r!.model).toBe('gpt-5.4')
  })

  it('resolves a direct provider id', () => {
    const r = unifiedResolve('baidu')
    expect(r).toBeDefined()
    expect(r!.kind).toBe('ccbRouting')
    expect(r!.id).toBe('baidu')
    expect(r!.model).toBe('deepseek-v4-pro')
    expect(r!.baseUrl).toBe('https://qianfan.baidubce.com/v2')
  })

  it('rejects a provider absent from the direct catalog', () => {
    const r = unifiedResolve('assemblyai')
    expect(r).toBeUndefined()
  })

  it('routes an unresolved bare prompt via advisorFallback', () => {
    const r = unifiedResolve('请对比一下这两种架构方案的优劣', {
      advisorFallback: true,
    })
    expect(r).toBeDefined()
    expect(r!.kind).toBe('advisor')
  })

  it('returns undefined for an unknown spec', () => {
    expect(unifiedResolve('no-such-provider-xyz-123')).toBeUndefined()
  })
})

describe('listUnifiedSources', () => {
  it('reports direct registry count', () => {
    const s = listUnifiedSources()
    expect(s.ccbRouting).toBeGreaterThan(0)
    expect(typeof s.ccbRouting).toBe('number')
  })
})
