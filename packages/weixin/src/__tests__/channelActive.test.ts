import { afterEach, describe, expect, test } from 'bun:test'
import { isChannelActive } from '../server.js'

const ORIGINAL = process.env.CLAUDE_ACTIVE_CHANNELS

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.CLAUDE_ACTIVE_CHANNELS
  else process.env.CLAUDE_ACTIVE_CHANNELS = ORIGINAL
})

describe('isChannelActive', () => {
  test('polls when the session opted in via --channels', () => {
    process.env.CLAUDE_ACTIVE_CHANNELS = 'weixin'
    expect(isChannelActive()).toBe(true)
  })

  test('polls when weixin is one of several channels', () => {
    process.env.CLAUDE_ACTIVE_CHANNELS = 'slack, weixin ,telegram'
    expect(isChannelActive()).toBe(true)
  })

  // Regression: every ccb session spawns this MCP server. Sessions that did
  // not opt in used to poll anyway, consuming messages from the shared bot
  // inbox and dropping them, so the session that did opt in never replied.
  test('does not poll when the session opted out', () => {
    process.env.CLAUDE_ACTIVE_CHANNELS = ''
    expect(isChannelActive()).toBe(false)
  })

  test('does not poll when only other channels are enabled', () => {
    process.env.CLAUDE_ACTIVE_CHANNELS = 'slack,telegram'
    expect(isChannelActive()).toBe(false)
  })

  test('polls when the var is absent (standalone / older CLI)', () => {
    delete process.env.CLAUDE_ACTIVE_CHANNELS
    expect(isChannelActive()).toBe(true)
  })
})
