import { describe, it, expect } from 'bun:test'
import {
  embed,
  cosine,
  centroid,
  classifyByEmbedding,
  EMBED_DIM,
} from '../embedding.js'

describe('ccbRouting / embedding (offline L2 classifier)', () => {
  it('embed returns a stable fixed dimension', () => {
    const a = embed('研究一下架构方案 best practice')
    const b = embed('another totally different prompt 调试 部署')
    expect(a.length).toBe(EMBED_DIM)
    expect(b.length).toBe(EMBED_DIM)
  })

  it('cosine of identical vectors equals 1', () => {
    const v = embed('hello world 测试')
    expect(cosine(v, v)).toBeCloseTo(1, 10)
  })

  it('cosine of orthogonal-ish distinct vectors is < 1', () => {
    const a = embed('research design strategy review')
    const b = embed('implement debug deploy build')
    expect(cosine(a, b)).toBeLessThan(1)
  })

  it('centroid returns the built-in advisory/work vectors of fixed dim', () => {
    const adv = centroid('advisory')
    const work = centroid('work')
    expect(adv.length).toBe(EMBED_DIM)
    expect(work.length).toBe(EMBED_DIM)
  })

  it("classifyByEmbedding routes an advisory phrase to 'advisory'", () => {
    const intent = classifyByEmbedding(
      '帮我分析一下两种技术的对比和最佳实践, 推荐一个设计方案',
    )
    expect(intent).toBe('advisory')
  })

  it("classifyByEmbedding routes a code phrase to 'work'", () => {
    const intent = classifyByEmbedding(
      '帮我写代码实现这个功能, 修复 bug 并部署到服务器',
    )
    expect(intent).toBe('work')
  })
})
