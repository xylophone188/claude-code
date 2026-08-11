import { describe, it, expect, afterEach } from 'bun:test'
import {
  classifyIntent,
  routeAdvisoryIntent,
  routeFull,
  setL2Classifier,
} from '../intentRouter.js'

describe('ccbRouting/intentRouter', () => {
  afterEach(() => setL2Classifier(null))

  it('classifyIntent: advisory prompt -> advisory/high', () => {
    const r = classifyIntent('请帮我研究一下微服务架构的最佳实践方案')
    expect(r.intent).toBe('advisory')
    expect(r.confidence).toBe('high')
  })

  it('classifyIntent: code prompt -> work/high', () => {
    const r = classifyIntent('实现一段代码修复这个 bug 并运行测试')
    expect(r.intent).toBe('work')
    expect(r.confidence).toBe('high')
  })

  it('routeAdvisoryIntent: advisory prompt uses top tier model', () => {
    const r = routeAdvisoryIntent('分析一下这个系统的架构设计')
    expect(r.model).toBe('openai/gpt-5.4')
    expect(r.tier).toBe('frontier')
  })

  it('routeFull: combo name resolves to combo + strategy', () => {
    const r = routeFull('advisor-combo')
    expect(r.combo).toBe('advisor-combo')
    expect(r.strategy).toBe('fallback')
    expect(r.model).toBe('openai/gpt-5.4')
  })

  it('routeFull: L2 classifier breaks L1 ties', () => {
    // Ambiguous prompt with weak signal -> L1 confidence low.
    const ambiguous = 'hello'
    expect(classifyIntent(ambiguous).confidence).toBe('low')

    setL2Classifier(() => 'work')
    const workRoute = routeFull(ambiguous)
    expect(workRoute.tier).toBe('fast')
    expect(workRoute.model).toBe('groq/llama-3.3-70b-versatile')

    setL2Classifier(() => 'advisory')
    const advRoute = routeFull(ambiguous)
    expect(advRoute.tier).toBe('frontier')
    expect(advRoute.model).toBe('openai/gpt-5.4')
  })
})
