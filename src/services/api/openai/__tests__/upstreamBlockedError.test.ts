import { describe, expect, test } from 'bun:test'
import {
  matchUpstreamCustomError,
  UpstreamBlockedError,
} from '../upstreamBlockedError.js'

describe('matchUpstreamCustomError', () => {
  test('matches the exact content-moderation wording', () => {
    const text =
      '抱歉，系统检测到您当前输入的信息存在敏感内容，我无法响应您的请求，请检查后重新输入。'
    expect(matchUpstreamCustomError(text)).toBe(text)
  })

  test('matches a shortened moderation variant', () => {
    const text =
      '抱歉，系统检测到您输入的内容存在敏感信息，无法响应您的请求，请检查后重新输入。'
    expect(matchUpstreamCustomError(text)).toBe(text)
  })

  test('matches generic cannot-respond refusal with retry hint', () => {
    const text = '抱歉，无法响应您的请求，请检查后重新输入。'
    expect(matchUpstreamCustomError(text)).toBe(text)
  })

  test('matches plain refusal with retry hint (no 抱歉 prefix)', () => {
    const text = '无法响应您的请求，请稍后再试。'
    expect(matchUpstreamCustomError(text)).toBe(text)
  })

  test('does not match a normal refusal without a retry hint', () => {
    const text = '我无法响应您的请求，因为这个问题需要更多上下文。'
    expect(matchUpstreamCustomError(text)).toBeUndefined()
  })

  test('does not match ordinary assistant text mentioning 敏感内容', () => {
    const text = '敏感内容审核是内容平台的基础能力，下面介绍其工作原理。'
    expect(matchUpstreamCustomError(text)).toBeUndefined()
  })

  test('does not match short assistant replies', () => {
    const text = '好的，请稍等。'
    expect(matchUpstreamCustomError(text)).toBeUndefined()
  })

  test('returns undefined for empty/null input', () => {
    expect(matchUpstreamCustomError('')).toBeUndefined()
    expect(matchUpstreamCustomError(null)).toBeUndefined()
    expect(matchUpstreamCustomError(undefined)).toBeUndefined()
  })
})

describe('UpstreamBlockedError', () => {
  test('carries the upstream_blocked code and original text', () => {
    const err = new UpstreamBlockedError(
      '抱歉，系统检测到您当前输入的信息存在敏感内容',
    )
    expect(err.code).toBe('upstream_blocked')
    expect(err.message).toContain('抱歉，系统检测到')
    expect(err.name).toBe('UpstreamBlockedError')
    expect(err instanceof Error).toBe(true)
  })
})
