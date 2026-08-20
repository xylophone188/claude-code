import { describe, expect, test } from 'bun:test'
import { createUserMessage } from '../../../utils/messages.js'
import { asSystemPrompt } from '../../../utils/systemPromptType.js'
import { addCacheBreakpoints, buildSystemPromptBlocks } from '../claude.js'

function countCacheControls(value: unknown): number {
  if (Array.isArray(value)) {
    return value.reduce((total, item) => total + countCacheControls(item), 0)
  }
  if (value === null || typeof value !== 'object') {
    return 0
  }
  return Object.entries(value).reduce(
    (total, [key, item]) =>
      total + (key === 'cache_control' ? 1 : countCacheControls(item)),
    0,
  )
}

describe('prompt cache breakpoints', () => {
  test('writes exactly one marker on the latest message', () => {
    const result = addCacheBreakpoints(
      [
        createUserMessage({ content: 'shared prefix' }),
        createUserMessage({ content: 'latest tail' }),
      ],
      true,
      'sdk',
    )

    expect(result.map(countCacheControls)).toEqual([0, 1])
    expect(countCacheControls(result)).toBe(1)
  })

  test('moves the only marker to the shared prefix when cache writes are skipped', () => {
    const result = addCacheBreakpoints(
      [
        createUserMessage({ content: 'shared prefix' }),
        createUserMessage({ content: 'fork tail' }),
      ],
      true,
      'sdk',
      false,
      null,
      undefined,
      true, // skipCacheWrite
    )

    expect(result.map(countCacheControls)).toEqual([1, 0])
    expect(countCacheControls(result)).toBe(1)
  })

  test('does not write a marker when prompt caching is disabled', () => {
    const result = addCacheBreakpoints(
      [
        createUserMessage({ content: 'shared prefix' }),
        createUserMessage({ content: 'latest tail' }),
      ],
      false,
      'sdk',
    )

    expect(countCacheControls(result)).toBe(0)
  })
})

describe('system prompt cache scopes', () => {
  test('marks only blocks with a cacheable scope', () => {
    const systemPrompt = asSystemPrompt([
      'x-anthropic-billing-header: test',
      'stable instructions',
    ])
    const disabled = buildSystemPromptBlocks(systemPrompt, false, {
      querySource: 'sdk',
    })
    const enabled = buildSystemPromptBlocks(systemPrompt, true, {
      querySource: 'sdk',
    })

    expect(disabled.map(countCacheControls)).toEqual([0, 0])
    expect(enabled.map(countCacheControls)).toEqual([0, 1])
    expect(enabled[1]?.cache_control).toMatchObject({ type: 'ephemeral' })
  })
})
