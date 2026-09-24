/**
 * End-to-end proof that the shadow receipt physically reaches the Anthropic
 * wire: a real HTTP listener captures the request and asserts the
 * `x-claude-code-shadow-receipt` header is present and parseable.
 *
 * The SDK is exercised for real — only the terminal endpoint is local, so the
 * `direct` dispatch decision, env-var injection, header serialization, and SSE
 * response parsing all run unmodified. The receipt context is provided exactly
 * as the QueryEngine→query() chain provides it (env vars).
 */
import { afterEach, beforeAll, describe, expect, mock, server, test } from 'bun:test'

type Captured = { method?: string; path?: string; headers?: Record<string, unknown> }

mock.module('bun:bundle', () => ({
  feature: () => false,
}))
mock.module('src/utils/log.ts', () => ({
  log: () => {},
  logError: () => {},
  logEvent: () => {},
}))
mock.module('src/utils/debug.ts', () => ({
  debugLogger: { log: () => {}, error: () => {} },
  ...new Proxy(
    {},
    {
      get: () => ({ log: () => {}, error: () => {} }),
    },
  ),
}))
mock.module('src/services/analytics/sink.js', () => ({
  setSink: () => {},
}))
mock.module('src/utils/processEvents.js', () => ({
  emitSessionStateChanged: () => {},
  getIsInteractive: () => false,
  getSessionState: () => 'idle',
  setSessionState: () => {},
}))
mock.module('src/services/langfuse/index.js', () => ({
  recordLLMObservation: async () => {},
  initLangfuse: () => {},
  flushLangfuse: async () => {},
}))
mock.module('src/services/langfuse/convert.js', () => ({
  convertMessagesToLangfuse: () => ({ model: '', token_count: 0 }),
  convertOutputToLangfuse: () => ({ text: '' }),
  convertToolsToLangfuse: () => [],
}))
mock.module('src/services/claude.ts', () => ({}))
mock.module('src/utils/messages.ts', () => ({
  getAssistantMessageFromQuery: () => ({ role: 'assistant' }),
  getMessagesAfterCompactBoundary: msgs => msgs,
  getToolResultsByIds: () => [],
  filterUnresolvedToolUseMessages: msgs => msgs,
}))
mock.module('src/utils/contextAnalysis.js', () => ({
  getAnalysisContext: () => ({}),
}))
mock.module('src/utils/messages/contextVisibility.js', () => ({
  filterVisibleMessagesForAPI: msgs => msgs,
  stripMessagesForAPI: msgs => msgs,
}))
mock.module('src/utils/messageQueueManager.js', () => ({
  enqueuePendingMemoryRetention: () => {},
}))
mock.module('src/utils/modelCost.js', () => ({
  getEffectiveAPIModel: () => 'claude-opus-4-8',
  getOpus46APIModel: () => 'claude-opus-4-6',
  getSonnet45APIModel: () => 'claude-sonnet-4-5',
  parseContextWindow: () => 200000,
}))
mock.module('src/utils/model/modelMetadata.js', () => ({
  getModelMaxOutputTokens: () => 32000,
  isMaxOutputTokensOverrideAllowed: () => false,
  is1MContextModel: () => false,
  is1MCtxFetched: () => false,
}))
mock.module('src/utils/fastMode.js', () => ({
  clearFastModeCache: () => {},
  isFastMode: () => false,
  isFastModeAvailable: () => false,
  isFastModeEnabledByConfig: () => false,
  isFastModeOptimisticGateEnabled: () => false,
  isFastModeCooldown: () => false,
  isInFastModeTransition: () => false,
  isMainLoopModel: () => false,
  shouldApplyFastDefaults: () => false,
}))
mock.module('src/utils/privacySettings.js', () => ({
  shouldShowPrivacyNotice: () => false,
}))
mock.module('src/utils/telemetry/posthog.js', () => ({
  addToTotalCounter: () => {},
}))
mock.module('src/utils/messages/agentCleanup.js', () => ({
  cleanupAgentToolsForEndTurn: () => {},
}))
mock.module('src/utils/messages/apiRequestPayload.js', () => ({
  buildPayloadWithTrace: async () => ({ payload: {}, traceId: 't', traceparent: 'p' }),
}))
mock.module('src/services/api/sessionTracking.js', () => ({
  updateSessionTrackingHeader: () => {},
}))
mock.module('src/utils/privacy.js', () => ({
  shouldExcludeFromMessages: () => true,
  shouldSkipDangerousModeWarningForUser: () => true,
  shouldDisableSandbox: () => false,
}))
mock.module('src/utils/agentId.js', () => ({
  isAgentIdleOrTerminated: () => false,
  isToolUseIdFormat: () => false,
}))
mock.module('src/services/sessionTranscript/sessionTranscript.js', () => ({
  flushAll: () => {},
}))
mock.module('src/utils/messageQueueManager.js', () => ({
  enqueuePendingMemoryRetention: () => {},
}))

const RECEIPT_CONTEXT_JSON = {
  ccb_shadow_receipt_v1: {
    schema: 'ccb.shadow.receipt.v1',
    scenario: 'unknown',
    scenario_origin: 'default@v1',
    profile_version: 'default@v1',
    factor_version: 'unavailable',
    factor_snapshot: 'unavailable',
    legacy_routing_source: 'direct (no candidate ranking)',
    ranking_summary: 'unavailable',
    bypass_detected: false,
    bypass_reason: 'none',
    route_id: 'direct@unknown',
  },
}

async function sse(payload: unknown): Promise<string> {
  return [
    'event: message_start\n',
    'data: {"type":"message_start","message":{"id":"msg_test","type":"message","role":"assistant","model":"claude-opus-4-8","content":[],"stop_reason":null,"usage":{"input_tokens":5,"output_tokens":1}}}\n\n',
    'event: content_block_start\n',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    'event: content_block_delta\n',
    `data: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: String(payload) } })}\n\n`,
    'event: content_block_stop\n',
    'data: {"type":"content_block_stop","index":0}\n\n',
    'event: message_delta\n',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":1}}\n\n',
    'event: message_stop\n',
    'data: {"type":"message_stop"}\n\n',
  ].join('')
}

describe('Claude adapter shadow receipt — real wire path', () => {
  beforeAll(() => {
    process.env.CCB_SHADOW_RECEIPT_JSON = JSON.stringify(RECEIPT_CONTEXT_JSON)
    process.env.CCB_ROUTE_ID = 'direct@unknown'
    delete process.env.CCB_ROUTE_ORIGIN_JSON
    process.env.CCB_POOL = 'main'
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test'
    delete process.env.ANTHROPIC_BASE_URL
    mock.module('src/services/api/client.js', () => ({
      getClientConfiguration: () => ({ apiKey: 'sk-ant-test', baseUrl: '' }),
      getAnthropicClient: () => undefined,
      CLIENT_REQUEST_ID_HEADER: 'x-claude-code-rid',
    }))
  })

  afterEach(() => {
    delete process.env.CCB_SHADOW_RECEIPT_JSON
    delete process.env.CCB_ROUTE_ID
  })

  test('shadow receipt header is emitted on the real /messages request', async () => {
    let captured: Captured | undefined
    const endpoint = server(() => {
      return new Response('not found', { status: 404 })
    })
    endpoint.post('/v1/messages', req => {
      captured = {
        method: req.method,
        path: req.url,
        headers: Object.fromEntries(req.headers.entries()),
      }
      return new Response(sse('hello'), {
        status: 200,
        headers: {
          'content-type': 'text/event-stream',
          'request-id': 'req_test_1',
          'anthropic-ratelimit-requests-limit': '100',
          'anthropic-ratelimit-requests-remaining': '99',
          'anthropic-ratelimit-tokens-limit': '1000',
          'anthropic-ratelimit-tokens-remaining': '999',
        },
      })
    })

    const { querySonnet } = await import('../claude.js')

    const { messages } = await querySonnet(
      [{ role: 'user', content: 'hi' } as unknown as Message[]],
      { signal: new AbortController().signal, thinkingConfig: { type: 'disabled' } as never },
      'claude-opus-4-8',
    )

    expect(captured?.method).toBe('POST')
    expect(captured?.path).toBe('/v1/messages')

    const headerValue = captured?.headers?.['x-claude-code-shadow-receipt']
    expect(typeof headerValue).toBe('string')
    expect(headerValue).toContain('ccb.shadow.receipt.v1')
    expect(headerValue).toContain('scenario=unknown')
    expect(headerValue).toContain('origin=default@v1')
    expect(headerValue).toContain('profile=default@v1')
    expect(headerValue).toContain('legacy=direct')
    expect(headerValue).toContain('rank=unavailable')
    expect(headerValue).toContain('bypass=0')
  })
})
