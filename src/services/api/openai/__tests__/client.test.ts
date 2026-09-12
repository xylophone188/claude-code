import { describe, expect, test } from 'bun:test'
import {
  getLastOmniRouteReceipt,
  parseOmniRouteReceipt,
} from '../../../omniroute/adapter.js'

function parseSseComments(body: string): Headers {
  const headers = new Headers()
  for (const line of body.split('\n')) {
    if (line.startsWith(': ') && line.includes('=')) {
      const kv = line.slice(2).split('=')
      const key = kv[0].trim().toLowerCase()
      const value = kv[1]?.trim()
      if (key && value !== undefined) {
        headers.set(key, value)
      }
    }
  }
  return headers
}

describe('OmniRoute SSE receipt parsing', () => {
  test('captures a slow-stream receipt from leading OmniRoute SSE comments', () => {
    const headers = parseSseComments(
      [
        ': omniroute-keepalive',
        '',
        ': x-omniroute-cognitive-pool=worker',
        ': x-omniroute-cognitive-effort=high',
        ': x-omniroute-context-project=Home-melody-ccb-source',
        ': x-omniroute-context-sources=codebase-memory,serena',
        'data: {"id":"chatcmpl-test"}',
        '',
      ].join('\n'),
    )

    parseOmniRouteReceipt(headers)

    expect(getLastOmniRouteReceipt()).toMatchObject({
      cognitivePool: 'worker',
      cognitiveEffort: 'high',
      contextProject: 'Home-melody-ccb-source',
      contextSources: 'codebase-memory,serena',
    })
  })

  test('ignores non-receipt SSE comments', () => {
    const headers = parseSseComments(
      ': omniroute-keepalive\n\ndata: [DONE]\n\n',
    )

    expect(parseOmniRouteReceipt(headers)).toBeNull()
  })

  test('parses standard receipt headers', () => {
    const headers = parseSseComments(
      [
        ': x-omniroute-request-id=req-abc',
        ': x-omniroute-provider=deepseek',
        ': x-omniroute-model=gpt-4o',
        ': x-omniroute-latency-ms=123',
        ': x-omniroute-fallback-attempts=2',
        ': x-omniroute-compression=trim',
        ': x-omniroute-decision=auto',
      ].join('\n'),
    )

    expect(parseOmniRouteReceipt(headers)).toEqual({
      requestId: 'req-abc',
      provider: 'deepseek',
      model: 'gpt-4o',
      latencyMs: 123,
      fallbackAttempts: 2,
      compression: 'trim',
      decision: 'auto',
    })
  })

  test('ignores malformed lines without crashing', () => {
    const headers = parseSseComments(
      [
        ': no-equals-here',
        ': x-omniroute-bad',
        ': ',
        ': x-omniroute-good=value',
        'data: payload',
      ].join('\n'),
    )

    const receipt = parseOmniRouteReceipt(headers)
    expect(receipt?.provider).toBeUndefined()
    expect(receipt?.requestId).toBeUndefined()
  })
})
