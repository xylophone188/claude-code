import { describe, test, expect, afterEach } from 'bun:test'
import { resolveCompactModel } from '../compact.js'

describe('resolveCompactModel', () => {
  const original = process.env.CCB_COMPACT_MODEL

  afterEach(() => {
    if (original === undefined) {
      delete process.env.CCB_COMPACT_MODEL
    } else {
      process.env.CCB_COMPACT_MODEL = original
    }
  })

  test('falls back to mainLoopModel when unset', () => {
    delete process.env.CCB_COMPACT_MODEL
    expect(resolveCompactModel('claude-sonnet-4-5')).toBe('claude-sonnet-4-5')
  })

  test('returns the override model when set', () => {
    process.env.CCB_COMPACT_MODEL = 'gpt-5.4-mini'
    expect(resolveCompactModel('claude-sonnet-4-5')).toBe('gpt-5.4-mini')
  })

  test('trims surrounding whitespace from the override', () => {
    process.env.CCB_COMPACT_MODEL = '  gpt-5.6-luna  '
    expect(resolveCompactModel('claude-sonnet-4-5')).toBe('gpt-5.6-luna')
  })

  test('empty/whitespace-only override falls back to mainLoopModel', () => {
    process.env.CCB_COMPACT_MODEL = '   '
    expect(resolveCompactModel('claude-sonnet-4-5')).toBe('claude-sonnet-4-5')
  })

  test('returns "auto" verbatim so the OpenAI adapter resolves the auto pool', () => {
    process.env.CCB_COMPACT_MODEL = 'auto'
    expect(resolveCompactModel('claude-sonnet-4-5')).toBe('auto')
  })
})
