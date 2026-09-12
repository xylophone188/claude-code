import { describe, expect, it } from 'bun:test'
import {
  isFakeSuccessBody,
  isJunkContent,
  validateResponseQuality,
} from '../responseQuality.js'

describe('validateResponseQuality', () => {
  it('rejects streams that delivered no content or events', () => {
    expect(validateResponseQuality({}).reason).toBe('empty')
    expect(
      validateResponseQuality({ text: '   ', chunkCount: 0 }).verdict,
    ).toBe('reject')
  })

  it('accepts a complete text completion', () => {
    const verdict = validateResponseQuality({
      text: 'Use `git diff --check` before committing to catch whitespace problems.',
      chunkCount: 3,
    })
    expect(verdict).toEqual({ verdict: 'ok', reason: 'ok' })
  })

  it('rejects upstream moderation text returned as HTTP 200', () => {
    const verdict = validateResponseQuality({
      text: '抱歉，系统检测到您当前输入的信息存在敏感内容。',
      status: 200,
    })
    expect(verdict.verdict).toBe('reject')
    expect(verdict.reason).toBe('fake200')
  })

  it('rejects JSON error envelopes returned as HTTP 200', () => {
    expect(
      validateResponseQuality({
        text: JSON.stringify({
          error: { code: 'rate_limit', message: 'quota exceeded' },
        }),
        status: 200,
      }).reason,
    ).toBe('fake200')
  })

  it('rejects HTML and truncated provider failures', () => {
    expect(
      validateResponseQuality({
        text: '<!DOCTYPE html><html><body><h1>502 Bad Gateway</h1></body></html>',
      }).reason,
    ).toBe('fake200')
    expect(
      validateResponseQuality({ text: 'context length exceeded' }).reason,
    ).toBe('fake200')
  })

  it('rejects replacement characters, control characters, and repetition junk', () => {
    expect(
      validateResponseQuality({ text: 'valid response \u{FFFD} garbage' })
        .reason,
    ).toBe('junk')
    expect(
      validateResponseQuality({
        text: `${'valid prefix '.repeat(2)}\x07${'suffix '.repeat(30)}`,
      }).reason,
    ).toBe('junk')
    expect(
      validateResponseQuality({ text: 'abababab'.repeat(30) }).reason,
    ).toBe('junk')
  })

  it('rejects text that is below the useful minimum', () => {
    expect(validateResponseQuality({ text: 'ok' }).reason).toBe('junk')
  })

  it('accepts a complete tool call without requiring prose', () => {
    const verdict = validateResponseQuality({
      text: '',
      toolCalls: [
        { type: 'function', function: { name: 'Read', arguments: '{}' } },
      ],
    })
    expect(verdict).toEqual({ verdict: 'ok', reason: 'ok' })
  })

  it('rejects a tool call without function details', () => {
    expect(
      validateResponseQuality({ toolCalls: [{ type: 'function' }] }).reason,
    ).toBe('truncated-tool-call')
  })

  it('accepts a tool call even when accumulated text looks like short junk', () => {
    const verdict = validateResponseQuality({
      text: '{"tool_calls":[{"function":{"name":"Read"}}]}',
      toolCalls: [
        { type: 'function', function: { name: 'Read', arguments: '{}' } },
      ],
      chunkCount: 2,
    })
    expect(verdict).toEqual({ verdict: 'ok', reason: 'ok' })
  })
})

describe('quality helpers', () => {
  it('exposes the fake-200 detector for shared error classification', () => {
    expect(
      isFakeSuccessBody('{"error":{"code":"invalid_request_error"}}'),
    ).toBe(true)
    expect(
      isFakeSuccessBody(
        'The router selected the fastest provider for the task.',
      ),
    ).toBe(false)
  })

  it('exposes the junk-content detector for stream consumers', () => {
    expect(isJunkContent('')).toBe(true)
    expect(isJunkContent('hello')).toBe(false)
    expect(
      isJunkContent('A complete sentence with enough context to be useful.'),
    ).toBe(false)
  })
})
