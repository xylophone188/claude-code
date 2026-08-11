import { describe, it, expect } from 'bun:test'
import {
  alignCacheBlocks,
  stablePrefixHash,
  type ChatMessage,
} from '../cacheAlign.js'

describe('alignCacheBlocks', () => {
  it('keeps the first system message at index 0', () => {
    const messages: Array<ChatMessage> = [
      { role: 'user', content: 'hi' },
      { role: 'system', content: 'you are helpful' },
      { role: 'assistant', content: 'hello' },
    ]
    const out = alignCacheBlocks(messages)
    expect(out[0].role).toBe('system')
    expect(out[0].content).toBe('you are helpful')
  })

  it('returns a NEW array and does not mutate the input', () => {
    const messages: Array<ChatMessage> = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'q' },
    ]
    const before = messages.slice()
    const out = alignCacheBlocks(messages)
    expect(out).not.toBe(messages)
    expect(messages).toEqual(before)
    // mutating output must not affect input
    out.push({ role: 'user', content: 'extra' })
    expect(messages.length).toBe(2)
  })

  it('preserves relative order of non-system messages after pinning system', () => {
    const messages: Array<ChatMessage> = [
      { role: 'user', content: 'u1' },
      { role: 'system', content: 'S' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'u2' },
    ]
    const out = alignCacheBlocks(messages)
    expect(out.map(m => m.content)).toEqual(['S', 'u1', 'a1', 'u2'])
  })
})

describe('stablePrefixHash', () => {
  it('is equal for the same leading prefix regardless of later turns', () => {
    const a: Array<ChatMessage> = [
      { role: 'system', content: 'S' },
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'a1' },
    ]
    const b: Array<ChatMessage> = [
      { role: 'system', content: 'S' },
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: 'DIFFERENT' },
      { role: 'user', content: 'u2' },
    ]
    expect(stablePrefixHash(a)).toBe(stablePrefixHash(b))
  })

  it('differs when the system block (cache anchor) changes', () => {
    const a: Array<ChatMessage> = [
      { role: 'system', content: 'S' },
      { role: 'user', content: 'u1' },
    ]
    const b: Array<ChatMessage> = [
      { role: 'system', content: 'S-CHANGED' },
      { role: 'user', content: 'u1' },
    ]
    expect(stablePrefixHash(a)).not.toBe(stablePrefixHash(b))
  })

  it('differs when the first user turn changes', () => {
    const a: Array<ChatMessage> = [
      { role: 'system', content: 'S' },
      { role: 'user', content: 'u1' },
    ]
    const b: Array<ChatMessage> = [
      { role: 'system', content: 'S' },
      { role: 'user', content: 'u2' },
    ]
    expect(stablePrefixHash(a)).not.toBe(stablePrefixHash(b))
  })
})
