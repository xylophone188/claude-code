import { describe, expect, test } from 'bun:test'
import { classifyAPIError } from '../errors.js'
import { UpstreamBlockedError } from '../openai/upstreamBlockedError.js'

describe('classifyAPIError with upstream blocked errors', () => {
  test('classifies UpstreamBlockedError as upstream_blocked', () => {
    const err = new UpstreamBlockedError(
      '抱歉，系统检测到您当前输入的信息存在敏感内容',
    )
    expect(classifyAPIError(err)).toBe('upstream_blocked')
  })

  test('classifies plain errors carrying the moderation wording', () => {
    const err = new Error(
      '抱歉，系统检测到您当前输入的信息存在敏感内容，我无法响应您的请求，请检查后重新输入。',
    )
    expect(classifyAPIError(err)).toBe('upstream_blocked')
  })

  test('leaves unrelated errors unclassified as upstream_blocked', () => {
    expect(classifyAPIError(new Error('something else'))).not.toBe(
      'upstream_blocked',
    )
  })
})
