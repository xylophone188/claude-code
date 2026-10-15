import { describe, expect, test } from 'bun:test'
import { getOpencodeModelName, isOpencodeModel } from '../model.js'
import { isModelAllowed } from '../modelAllowlist.js'

describe('opencode model routing', () => {
  test('recognizes prefixed models case-insensitively', () => {
    expect(isOpencodeModel('opencode/space-bunny-free')).toBe(true)
    expect(isOpencodeModel('OpenCode/mimo-v2.5-free')).toBe(true)
    expect(isOpencodeModel('space-bunny-free')).toBe(false)
    expect(isOpencodeModel('opencode/')).toBe(false)
  })

  test('removes only routing prefix and preserves model name', () => {
    expect(getOpencodeModelName('opencode/space-bunny-free')).toBe(
      'space-bunny-free',
    )
    expect(getOpencodeModelName('OpenCode/MiMo-V2.5-Free')).toBe(
      'MiMo-V2.5-Free',
    )
    expect(getOpencodeModelName('custom-model')).toBe('custom-model')
  })

  test('allows non-empty OpenCode models regardless of provider allowlist', () => {
    expect(isModelAllowed('opencode/space-bunny-free')).toBe(true)
    expect(isModelAllowed('opencode/')).toBe(false)
  })
})
