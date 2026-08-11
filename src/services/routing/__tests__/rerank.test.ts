import { describe, test, expect } from 'bun:test'
import { rerank, termOverlap, type RerankItem } from '../rerank.js'

describe('rerank', () => {
  test('sorts desc by numeric score', () => {
    const items: RerankItem[] = [
      { id: 'a', score: 0.2 },
      { id: 'b', score: 0.9 },
      { id: 'c', score: 0.5 },
    ]
    expect(rerank(items).map(i => i.id)).toEqual(['b', 'c', 'a'])
  })

  test('stable among equal scores', () => {
    const items: RerankItem[] = [
      { id: 'a', score: 0.5 },
      { id: 'b', score: 0.5 },
      { id: 'c', score: 0.5 },
    ]
    expect(rerank(items).map(i => i.id)).toEqual(['a', 'b', 'c'])
  })

  test('falls back to term-overlap when query given and no scores', () => {
    const items: RerankItem[] = [
      { id: 'a', text: 'the quick brown fox' },
      { id: 'b', text: 'lazy dog sleeps' },
      { id: 'c', text: 'quick brown dog runs' },
    ]
    const result = rerank(items, 'quick brown dog')
    expect(result[0].id).toBe('c')
    expect(result.map(i => i.id)).not.toEqual(['a', 'b', 'c'])
  })

  test('termOverlap is case-insensitive and token based', () => {
    expect(termOverlap('The Quick Fox', 'quick FOX jumps')).toBe(2)
    expect(termOverlap('alpha beta', 'gamma delta')).toBe(0)
  })

  test('preserves original order when neither score nor query', () => {
    const items: RerankItem[] = [
      { id: 'x', text: 'alpha' },
      { id: 'y', text: 'beta' },
      { id: 'z', text: 'gamma' },
    ]
    expect(rerank(items).map(i => i.id)).toEqual(['x', 'y', 'z'])
  })

  test('empty input returns empty', () => {
    expect(rerank([])).toEqual([])
  })
})
