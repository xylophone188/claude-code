import { describe, it, expect } from 'bun:test'
import {
  estimateTokens,
  trimToBudget,
  extractiveSummarize,
  computeStats,
  type ChatMessage,
} from '../compress.js'

const mk = (role: string, content: string): ChatMessage => ({ role, content })

describe('context compression strategies', () => {
  it('estimateTokens is monotonic and ~chars/4', () => {
    expect(estimateTokens('')).toBe(0)
    expect(estimateTokens('abcd')).toBe(1)
    expect(estimateTokens('abcdefgh')).toBe(2)
    expect(estimateTokens('a'.repeat(40))).toBe(10)
    expect(estimateTokens('short')).toBeLessThanOrEqual(
      estimateTokens('this is much longer text'),
    )
  })

  it('trimToBudget keeps system and respects budget', () => {
    const msgs = [
      mk('system', 'you are a helpful assistant'),
      mk('user', 'hello there friend'),
      mk('assistant', 'hi how can I help you today'),
      mk('user', 'tell me a long story about a fox and a dog and a cat'),
    ]
    const budget =
      estimateTokens('you are a helpful assistant') +
      estimateTokens('hello there friend')
    const out = trimToBudget(msgs, budget)
    expect(out.some(m => m.role === 'system')).toBe(true)
    const total = out.reduce((s, m) => s + estimateTokens(m.content), 0)
    expect(total).toBeLessThanOrEqual(budget)
    // System was preserved even though it alone may exceed budget.
    expect(out.length).toBeGreaterThanOrEqual(1)
  })

  it('trimToBudget drops oldest non-system first', () => {
    const msgs = [
      mk('system', 'sys'),
      mk('user', 'first old message'),
      mk('user', 'second message'),
      mk('user', 'third recent message'),
    ]
    const out = trimToBudget(
      msgs,
      estimateTokens('sys') + estimateTokens('third recent message'),
    )
    expect(out).toContainEqual(mk('system', 'sys'))
    expect(out).toContainEqual(mk('user', 'third recent message'))
    expect(out.find(m => m.content === 'first old message')).toBeUndefined()
  })

  it('extractiveSummarize reduces size', () => {
    const msgs = [
      mk(
        'user',
        'The cat sat on the mat. The dog ran in the park. The fox slept under the tree. The bird flew over the river. We should refactor the parser module now.',
      ),
    ]
    const before = msgs.reduce((s, m) => s + estimateTokens(m.content), 0)
    const out = extractiveSummarize(msgs, 0.5)
    expect(out).toHaveLength(1)
    const after = out.reduce((s, m) => s + estimateTokens(m.content), 0)
    expect(after).toBeLessThan(before)
  })

  it('extractiveSummarize never shrinks a system message', () => {
    const sys = 'keep this exact system prompt intact no matter what happens'
    const out = extractiveSummarize([mk('system', sys)], 0.1)
    expect(out[0].content).toBe(sys)
  })

  it('computeStats reports reduction', () => {
    const before = [
      mk(
        'user',
        'The cat sat on the mat. The dog ran in the park. The fox slept under the tree. The bird flew over the river.',
      ),
    ]
    const after = extractiveSummarize(before, 0.5)
    const stats = computeStats(before, after)
    expect(stats.retainedMessages).toBe(1)
    expect(stats.reduction).toBeGreaterThan(0)
    expect(stats.outputTokens).toBeLessThanOrEqual(stats.inputTokens)
  })
})
