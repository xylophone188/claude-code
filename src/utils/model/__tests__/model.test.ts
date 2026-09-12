import { describe, expect, test } from 'bun:test'
import {
  firstPartyNameToCanonical,
  getDefaultMainLoopModelSetting,
  renderModelSetting,
} from '../model'

describe('firstPartyNameToCanonical', () => {
  test('maps opus-4-6 full name to canonical', () => {
    expect(firstPartyNameToCanonical('claude-opus-4-6-20250514')).toBe(
      'claude-opus-4-6',
    )
  })

  test('maps sonnet-4-6 full name', () => {
    expect(firstPartyNameToCanonical('claude-sonnet-4-6-20250514')).toBe(
      'claude-sonnet-4-6',
    )
  })

  test('maps haiku-4-5', () => {
    expect(firstPartyNameToCanonical('claude-haiku-4-5-20251001')).toBe(
      'claude-haiku-4-5',
    )
  })

  test('maps 3P provider format', () => {
    expect(firstPartyNameToCanonical('us.anthropic.claude-opus-4-6-v1:0')).toBe(
      'claude-opus-4-6',
    )
  })

  test('maps claude-3-7-sonnet', () => {
    expect(firstPartyNameToCanonical('claude-3-7-sonnet-20250219')).toBe(
      'claude-3-7-sonnet',
    )
  })

  test('maps claude-3-5-sonnet', () => {
    expect(firstPartyNameToCanonical('claude-3-5-sonnet-20241022')).toBe(
      'claude-3-5-sonnet',
    )
  })

  test('maps claude-3-5-haiku', () => {
    expect(firstPartyNameToCanonical('claude-3-5-haiku-20241022')).toBe(
      'claude-3-5-haiku',
    )
  })

  test('maps claude-3-opus', () => {
    expect(firstPartyNameToCanonical('claude-3-opus-20240229')).toBe(
      'claude-3-opus',
    )
  })

  test('is case insensitive', () => {
    expect(firstPartyNameToCanonical('Claude-Opus-4-6-20250514')).toBe(
      'claude-opus-4-6',
    )
  })

  test('falls back to input for unknown model', () => {
    expect(firstPartyNameToCanonical('unknown-model')).toBe('unknown-model')
  })

  test('differentiates opus-4 vs opus-4-5 vs opus-4-6', () => {
    expect(firstPartyNameToCanonical('claude-opus-4-20240101')).toBe(
      'claude-opus-4',
    )
    expect(firstPartyNameToCanonical('claude-opus-4-5-20240101')).toBe(
      'claude-opus-4-5',
    )
    expect(firstPartyNameToCanonical('claude-opus-4-6-20240101')).toBe(
      'claude-opus-4-6',
    )
  })

  test('maps opus-4-1', () => {
    expect(firstPartyNameToCanonical('claude-opus-4-1-20240101')).toBe(
      'claude-opus-4-1',
    )
  })

  test('maps sonnet-4-5', () => {
    expect(firstPartyNameToCanonical('claude-sonnet-4-5-20240101')).toBe(
      'claude-sonnet-4-5',
    )
  })

  test('maps sonnet-4', () => {
    expect(firstPartyNameToCanonical('claude-sonnet-4-20240101')).toBe(
      'claude-sonnet-4',
    )
  })
})

describe('CCB OmniRoute display', () => {
  test('labels gateway aliases as automatic routing', () => {
    const previous = {
      ccb: process.env.CCB_ENV,
      hermes: process.env.HERMES_SCORE_DEFAULT,
      omniroute: process.env.OMNIROUTE_BASE_URL,
    }
    process.env.CCB_ENV = '1'
    process.env.OMNIROUTE_BASE_URL = 'http://127.0.0.1:20128/v1'
    try {
      expect(getDefaultMainLoopModelSetting()).toBe('auto')
      expect(renderModelSetting('auto')).toBe('OmniRoute 自动路由')
      expect(renderModelSetting('hermes-score')).toBe('OmniRoute 自动路由')
      expect(renderModelSetting('ccb-chat')).toBe('CCB · 对话')
      expect(renderModelSetting('ccb-research')).toBe('CCB · 研究')
      expect(renderModelSetting('ccb-coding')).toBe('CCB · 编码')
      expect(renderModelSetting('ccb-plan')).toBe('CCB · 规划')
      expect(renderModelSetting('ccb-review')).toBe('CCB · 审核')
      expect(renderModelSetting('ccb-vision')).toBe('CCB · 视图')
      expect(renderModelSetting('ccb-crawl')).toBe('CCB · 爬取')
      expect(renderModelSetting('ccb-search')).toBe('CCB · 搜索')
    } finally {
      if (previous.ccb === undefined) delete process.env.CCB_ENV
      else process.env.CCB_ENV = previous.ccb
      if (previous.hermes === undefined) delete process.env.HERMES_SCORE_DEFAULT
      else process.env.HERMES_SCORE_DEFAULT = previous.hermes
      if (previous.omniroute === undefined)
        delete process.env.OMNIROUTE_BASE_URL
      else process.env.OMNIROUTE_BASE_URL = previous.omniroute
    }
  })
})
