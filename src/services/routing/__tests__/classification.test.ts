/**
 * ccbRouting / classification V2 test — pure, no network. Exercises L1-only, L2 override on low
 * confidence, L2 override on disagreement, and L1+L2 agreement layer tagging.
 */
import { describe, it, expect } from 'bun:test'
import { classifyV2 } from '../classification.js'

describe('classifyV2 — L1-only path', () => {
  it('routes an advisory prompt to advisory with high confidence (layer L1)', () => {
    const r = classifyV2('请分析一下微服务架构的优缺点，帮我做技术选型')
    expect(r.intent).toBe('advisory')
    expect(r.confidence).toBe('high')
    expect(r.layer).toBe('L1')
  })

  it('routes a work prompt to work with high confidence (layer L1)', () => {
    const r = classifyV2('帮我修复这个 bug 并运行测试，然后 git commit')
    expect(r.intent).toBe('work')
    expect(r.confidence).toBe('high')
    expect(r.layer).toBe('L1')
  })
})

describe('classifyV2 — L2 optional layer', () => {
  it('overrides L1 with L2 when L1 confidence is low (layer L2)', () => {
    // "你好" has no signal -> L1 low confidence; L2 says advisory.
    const r = classifyV2('你好', { l2: () => 'advisory' })
    expect(r.intent).toBe('advisory')
    expect(r.confidence).toBe('low')
    expect(r.layer).toBe('L2')
    expect(r.reason).toContain('L2 override')
  })

  it('prefers L2 on L1 vs L2 disagreement and tags L1+L2', () => {
    // L1 sees "实现" -> work (high); L2 embedding says advisory -> L2 wins.
    const r = classifyV2('请实现并部署这个功能', { l2: () => 'advisory' })
    expect(r.intent).toBe('advisory')
    expect(r.layer).toBe('L1+L2')
    expect(r.reason).toContain('disagrees')
  })

  it('tags L1+L2 and keeps L1 intent when L1 and L2 agree', () => {
    const r = classifyV2('请分析架构方案', { l2: () => 'advisory' })
    expect(r.intent).toBe('advisory')
    expect(r.layer).toBe('L1+L2')
    expect(r.reason).toContain('agrees')
  })

  it('falls back to pure L1 when L2 returns null', () => {
    const r = classifyV2('帮我运行测试', { l2: () => null })
    expect(r.intent).toBe('work')
    expect(r.layer).toBe('L1')
  })
})
