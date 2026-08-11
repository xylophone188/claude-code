/**
 * Kiro translator — lets claude-code's OpenAI-only race pool talk to Kiro's
 * native `generateAssistantResponse` endpoint.
 *
 * Kiro's managed gateway (runtime.<region>.kiro.dev) accepts an OpenAI-shaped
 * chat body with a Bearer token and replies with an AWS EventStream
 * (application/vnd.amazon.eventstream) binary stream. We POST the OpenAI body
 * and translate the EventStream response back into OpenAI ChatCompletionChunk
 * objects, reusing 9router's kiro executor mapping (executors/kiro.js).
 *
 * Note: only the OAuth/social-token → kiro.dev path is supported here. The raw
 * CodeWhisperer *.amazonaws.com surface (api_key / external_idp / IAM Identity
 * Center) requires AWS SigV4 signing and is intentionally out of scope.
 */
import type { ChatCompletionChunk } from 'openai/resources/chat/completions'
import {
  crc32,
  parseEventFrame,
  EVENTSTREAM_MAX_MESSAGE_BYTES,
  EVENTSTREAM_MAX_HEADERS_BYTES,
} from './eventStream.js'

const KIRO_EVENT_TYPES = new Set([
  'assistantResponseEvent',
  'reasoningContentEvent',
  'codeEvent',
  'toolUseEvent',
  'messageStopEvent',
  'metadataEvent',
  'MetadataEvent',
  'contextUsageEvent',
  'meteringEvent',
  'metricsEvent',
])

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function normalizeStopReason(value: unknown): string | null {
  const reason = String(value || '')
    .trim()
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
  if (['endturn', 'end_turn', 'stop', 'stop_sequence'].includes(reason))
    return 'end_turn'
  if (['tooluse', 'tool_use', 'tool_calls'].includes(reason)) return 'tool_use'
  if (
    ['maxtokens', 'max_tokens', 'max_output_tokens', 'length'].includes(reason)
  )
    return 'max_tokens'
  return reason || null
}

function stopDisposition(
  stopReason: string | null,
  hasToolCalls: boolean,
): string {
  if (
    ['malformed_model_output', 'invalid_model_output'].includes(
      stopReason ?? '',
    )
  )
    return 'retryable_protocol_failure'
  if (
    ['cancelled', 'pause_turn', 'model_context_window_exceeded'].includes(
      stopReason ?? '',
    )
  )
    return 'terminal_incomplete'
  if (
    stopReason === 'refusal' ||
    /(?:content.*filter|guardrail|safety|policy|blocked)/u.test(
      stopReason ?? '',
    )
  )
    return 'terminal_refusal'
  if (stopReason === 'max_tokens')
    return hasToolCalls ? 'terminal_incomplete' : 'length'
  if (stopReason && !['end_turn', 'tool_use'].includes(stopReason))
    return 'unknown_failure'
  if (hasToolCalls || stopReason === 'tool_use') return 'tool_use'
  if (!stopReason || stopReason === 'end_turn') return 'complete'
  return 'unknown_failure'
}

function mergeStopReason(
  current: string | null,
  incoming: string | null,
): string | null {
  if (!incoming) return current
  if (!current) return incoming
  const severity = (reason: string | null) => {
    const disposition = stopDisposition(reason, false)
    if (disposition === 'terminal_refusal') return 6
    if (disposition === 'terminal_incomplete') return 5
    if (disposition === 'unknown_failure') return 4
    if (disposition === 'retryable_protocol_failure') return 3
    if (disposition === 'length') return 2
    return 1
  }
  return severity(incoming) > severity(current) ? incoming : current
}

interface KiroState {
  buffer: Uint8Array
  chunkIndex: number
  toolCounter: number
  tools: Map<
    string,
    {
      id: string
      name: string
      inputKind?: string
      inputChunks?: string[]
      inputObject?: unknown
      inputBytes?: number
    }
  >
  bufferedToolBytes: number
  hasText: boolean
  hasReasoning: boolean
  hasCode: boolean
  hasToolCalls: boolean
  sawToolUse: boolean
  explicitStop: boolean
  stopReason: string | null
  totalContentLength: number
  usage: Record<string, number> | null
  finished: boolean
}

function initialState(): KiroState {
  return {
    buffer: new Uint8Array(0),
    chunkIndex: 0,
    toolCounter: 0,
    tools: new Map(),
    bufferedToolBytes: 0,
    hasText: false,
    hasReasoning: false,
    hasCode: false,
    hasToolCalls: false,
    sawToolUse: false,
    explicitStop: false,
    stopReason: null,
    totalContentLength: 0,
    usage: null,
    finished: false,
  }
}

export interface KiroStreamCallbacks {
  onChunk: (chunk: ChatCompletionChunk) => void
  onError: (error: Error) => void
}

/**
 * Decode a Kiro AWS EventStream response body into OpenAI ChatCompletionChunks.
 * Mirrors 9router's transformEventStreamToSSE core mapping (without the
 * integrity-recovery/repair wrapper, which re-reads and rewrites the stream).
 */
export async function kiroEventStreamToChunks(
  body: ReadableStream<Uint8Array> | null,
  model: string,
  callbacks: KiroStreamCallbacks,
): Promise<void> {
  const state = initialState()
  const responseId = `chatcmpl-${Date.now()}`
  const created = Math.floor(Date.now() / 1000)

  if (!body) {
    callbacks.onError(
      new Error('Kiro response did not include an EventStream body'),
    )
    return
  }

  const sseChunk = (
    delta: Record<string, unknown>,
    finishReason: string | null = null,
    usage?: Record<string, number>,
  ): ChatCompletionChunk =>
    ({
      id: responseId,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [
        {
          index: 0,
          delta: delta as ChatCompletionChunk['choices'][0]['delta'],
          finish_reason:
            finishReason as ChatCompletionChunk['choices'][0]['finish_reason'],
        },
      ],
      ...(usage
        ? { usage: usage as unknown as ChatCompletionChunk['usage'] }
        : {}),
    }) as ChatCompletionChunk

  const emitDelta = (delta: Record<string, unknown>) => {
    if (state.chunkIndex === 0) {
      callbacks.onChunk(sseChunk({ role: 'assistant', ...delta }))
    } else {
      callbacks.onChunk(sseChunk(delta))
    }
    state.chunkIndex++
  }

  const assertToolBufferBound = (maxToolBytes: number) => {
    if (state.bufferedToolBytes <= maxToolBytes) return
    const error = new Error(
      'Kiro buffered tool input exceeded the integrity memory bound',
    )
    error.name = 'KIRO_BUFFER_EXCEEDED'
    throw error
  }

  const appendToolInput = (
    tool: NonNullable<ReturnType<KiroState['tools']['get']>>,
    input: unknown,
    maxToolBytes: number,
  ) => {
    if (input === undefined) return
    if (typeof input === 'string') {
      if (tool.inputKind && tool.inputKind !== 'string')
        throw new Error('Kiro tool input changed fragment type')
      tool.inputKind = 'string'
      tool.inputChunks ||= []
      tool.inputChunks.push(input)
      state.bufferedToolBytes += encoder.encode(input).byteLength
    } else if (input && typeof input === 'object' && !Array.isArray(input)) {
      if (tool.inputKind && tool.inputKind !== 'object')
        throw new Error('Kiro tool input changed fragment type')
      tool.inputKind = 'object'
      state.bufferedToolBytes -= tool.inputBytes || 0
      tool.inputObject = input
      tool.inputBytes = encoder.encode(JSON.stringify(input)).byteLength
      state.bufferedToolBytes += tool.inputBytes
    } else {
      throw new Error('Kiro tool input must be a JSON object')
    }
    assertToolBufferBound(maxToolBytes)
  }

  const parsedToolInput = (
    tool: NonNullable<ReturnType<KiroState['tools']['get']>>,
  ): Record<string, unknown> => {
    if (!tool.inputKind) throw new Error('Kiro tool call is missing input')
    if (tool.inputKind === 'object')
      return tool.inputObject as Record<string, unknown>
    try {
      const input = JSON.parse((tool.inputChunks ?? []).join(''))
      if (!input || typeof input !== 'object' || Array.isArray(input))
        throw new Error('not an object')
      return input
    } catch (error) {
      throw new Error(
        `Kiro tool input must be valid object JSON (${(error as Error).message})`,
      )
    }
  }

  const emitTools = () => {
    for (const tool of state.tools.values()) {
      const input = parsedToolInput(tool)
      const index = state.toolCounter++
      emitDelta({
        tool_calls: [
          {
            index,
            id: tool.id,
            type: 'function',
            function: { name: tool.name, arguments: '' },
          },
        ],
      })
      emitDelta({
        tool_calls: [{ index, function: { arguments: JSON.stringify(input) } }],
      })
      state.hasToolCalls = true
    }
    state.tools.clear()
    state.bufferedToolBytes = 0
  }

  const fail = (code: string, message: string) => {
    state.finished = true
    callbacks.onError(Object.assign(new Error(message), { code }))
  }

  const processEvent = (
    event: {
      headers: Record<string, unknown>
      payload: Record<string, unknown> | null
    },
    maxToolBytes: number,
  ): boolean => {
    const messageType = event.headers[':message-type'] as string | undefined
    if (messageType === 'error' || messageType === 'exception') {
      fail(
        'kiro_upstream_eventstream_error',
        (event.payload?.message as string) ||
          `Kiro upstream sent an EventStream ${messageType}`,
      )
      return false
    }

    const eventType = (event.headers[':event-type'] as string) || ''
    if (
      eventType === 'assistantResponseEvent' &&
      typeof event.payload?.content === 'string'
    ) {
      let content = event.payload.content
      // Kiro sometimes wraps reasoning in <thinking>…</thinking> inside content.
      const start = content.indexOf('<thinking>')
      if (start >= 0) {
        const end = content.indexOf('</thinking>', start + 10)
        if (end < 0) content = content.slice(0, start)
        else
          content =
            content.slice(0, start) +
            content.slice(end + 11).replace(/^\n/u, '')
      }
      if (content || !state.hasReasoning) {
        state.hasText ||= content.length > 0
        state.totalContentLength += content.length
        emitDelta({ content })
      }
    } else if (eventType === 'reasoningContentEvent') {
      const value =
        (event.payload?.reasoningContentEvent as Record<string, unknown>) ||
        event.payload ||
        {}
      const content =
        typeof value === 'string'
          ? value
          : (value.text as string) || (value.content as string) || ''
      if (content) {
        state.hasReasoning = true
        state.totalContentLength += content.length
        emitDelta({ reasoning_content: content })
      }
    } else if (
      eventType === 'codeEvent' &&
      typeof event.payload?.content === 'string'
    ) {
      state.hasCode = true
      state.totalContentLength += event.payload.content.length
      emitDelta({ content: event.payload.content })
    } else if (eventType === 'toolUseEvent') {
      state.sawToolUse = true
      const values = Array.isArray(event.payload)
        ? event.payload
        : [event.payload]
      if (!values[0]) throw new Error('Kiro toolUseEvent is empty')
      for (const v of values) {
        const value = v as Record<string, unknown>
        const name = typeof value?.name === 'string' ? value.name.trim() : ''
        if (!name) throw new Error('Kiro toolUseEvent is missing a tool name')
        let id: string
        if (value.toolUseId == null)
          id = `call_${created}_${state.tools.size + 1}`
        else if (typeof value.toolUseId !== 'string' || !value.toolUseId.trim())
          throw new Error('Kiro toolUseEvent has an invalid toolUseId')
        else id = value.toolUseId
        let tool = state.tools.get(id)
        if (!tool) {
          tool = { id, name }
          state.tools.set(id, tool)
          state.bufferedToolBytes +=
            encoder.encode(id).byteLength + encoder.encode(name).byteLength + 32
          assertToolBufferBound(maxToolBytes)
        } else if (tool.name !== name) {
          throw new Error('Kiro tool name changed between fragments')
        }
        appendToolInput(tool, value.input, maxToolBytes)
      }
    } else if (eventType === 'messageStopEvent') {
      state.explicitStop = true
      const reason =
        normalizeStopReason(
          event.payload?.stopReason ?? event.payload?.stop_reason,
        ) || (state.sawToolUse ? 'tool_use' : 'end_turn')
      state.stopReason = mergeStopReason(state.stopReason, reason)
    } else if (eventType === 'metadataEvent' || eventType === 'MetadataEvent') {
      const metadata =
        (event.payload?.metadataEvent as Record<string, unknown>) ||
        event.payload?.metadata ||
        event.payload ||
        {}
      const reason = normalizeStopReason(
        metadata?.stopReason ?? metadata?.stop_reason,
      )
      if (reason) {
        state.explicitStop = true
        state.stopReason = mergeStopReason(state.stopReason, reason)
      }
    } else if (eventType === 'metricsEvent') {
      const metrics =
        (event.payload?.metricsEvent as Record<string, unknown>) ||
        event.payload ||
        {}
      const prompt = Number(metrics.inputTokens) || 0
      const completion = Number(metrics.outputTokens) || 0
      if (prompt || completion) {
        state.usage = {
          ...(state.usage || {}),
          prompt_tokens: prompt,
          completion_tokens: completion,
          total_tokens: prompt + completion,
        }
        const cacheRead =
          Number(
            metrics.cacheReadInputTokens || metrics.cache_read_input_tokens,
          ) || 0
        const cacheCreate =
          Number(
            metrics.cacheCreationInputTokens ||
              metrics.cache_creation_input_tokens,
          ) || 0
        if (cacheRead) state.usage.cache_read_input_tokens = cacheRead
        if (cacheCreate) state.usage.cache_creation_input_tokens = cacheCreate
      }
    }
    // contextUsageEvent / meteringEvent are informational; ignored for chunk mapping.
    return true
  }

  const processBytes = (chunk: Uint8Array, maxToolBytes: number): boolean => {
    const combinedLength = state.buffer.byteLength + chunk.byteLength
    if (combinedLength > EVENTSTREAM_MAX_MESSAGE_BYTES) {
      fail(
        'kiro_missing_terminal',
        'Kiro EventStream buffered bytes exceed the protocol bound',
      )
      return false
    }
    if (state.buffer.byteLength === 0) state.buffer = chunk
    else {
      const joined = new Uint8Array(combinedLength)
      joined.set(state.buffer)
      joined.set(chunk, state.buffer.byteLength)
      state.buffer = joined
    }

    while (state.buffer.byteLength >= 12) {
      const view = new DataView(state.buffer.buffer, state.buffer.byteOffset)
      if (view.getUint32(8, false) !== crc32(state.buffer.subarray(0, 8))) {
        fail('kiro_missing_terminal', 'Kiro EventStream prelude CRC mismatch')
        return false
      }
      const totalLength = view.getUint32(0, false)
      const headersLength = view.getUint32(4, false)
      if (
        totalLength < 16 ||
        totalLength > EVENTSTREAM_MAX_MESSAGE_BYTES ||
        headersLength > EVENTSTREAM_MAX_HEADERS_BYTES ||
        headersLength > totalLength - 16
      ) {
        fail(
          'kiro_missing_terminal',
          'Kiro EventStream frame bounds are invalid',
        )
        return false
      }
      if (state.buffer.byteLength < totalLength) break
      const frame = state.buffer.slice(0, totalLength)
      state.buffer = state.buffer.slice(totalLength)
      let event: {
        headers: Record<string, unknown>
        payload: Record<string, unknown> | null
      }
      try {
        event = parseEventFrame(frame)
      } catch (error) {
        fail('kiro_missing_terminal', (error as Error).message)
        return false
      }
      try {
        if (!processEvent(event, maxToolBytes)) return false
      } catch (error) {
        fail('invalid_kiro_tool_call', (error as Error).message)
        return false
      }
    }
    return true
  }

  const finish = () => {
    if (state.finished) return
    if (state.buffer.byteLength) {
      fail(
        'kiro_missing_terminal',
        'Kiro EventStream ended with a truncated frame',
      )
      return
    }
    const disposition = stopDisposition(state.stopReason, state.hasToolCalls)
    if (
      [
        'retryable_protocol_failure',
        'terminal_incomplete',
        'terminal_refusal',
        'unknown_failure',
      ].includes(disposition)
    ) {
      fail(
        'kiro_upstream_eventstream_error',
        `Kiro ended with non-success stop reason: ${state.stopReason}`,
      )
      return
    }
    try {
      emitTools()
    } catch (error) {
      fail('invalid_kiro_tool_call', (error as Error).message)
      return
    }
    const hasOutput =
      state.hasText || state.hasReasoning || state.hasCode || state.hasToolCalls
    if (!hasOutput && !state.explicitStop) {
      fail(
        'kiro_missing_terminal',
        'Kiro EventStream ended without model output',
      )
      return
    }
    const finishReason = state.hasToolCalls
      ? 'tool_calls'
      : disposition === 'length'
        ? 'length'
        : 'stop'
    callbacks.onChunk(sseChunk({}, finishReason, state.usage ?? undefined))
    state.finished = true
  }

  const reader = body.getReader()
  const maxToolBytes = EVENTSTREAM_MAX_MESSAGE_BYTES / 2
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (!processBytes(value, maxToolBytes)) {
        await reader.cancel('invalid Kiro EventStream').catch(() => {})
        break
      }
    }
    finish()
  } catch (error) {
    if (!state.finished) {
      fail(
        'kiro_missing_terminal',
        (error as Error).message || 'Kiro EventStream read failed',
      )
    }
  } finally {
    try {
      await reader.cancel().catch(() => {})
    } catch {
      /* ignore */
    }
  }
}

export interface KiroRequestOptions {
  baseURL: string
  apiKey: string
  model: string
  body: unknown
  headers?: Record<string, string>
  timeoutMs?: number
  signal?: AbortSignal
  fetchImpl?: typeof fetch
}

/**
 * Open a Kiro generateAssistantResponse stream and yield OpenAI chunks.
 * The request body is sent OpenAI-shaped (kiro.dev translates it server-side),
 * matching 9router's kiro executor pass-through.
 */
export async function* createKiroStream(
  opts: KiroRequestOptions,
): AsyncGenerator<ChatCompletionChunk> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/vnd.amazon.eventstream',
    'User-Agent': 'AWS-SDK-JS/3.0.0 kiro-ide/1.0.0',
    'X-Amz-User-Agent': 'aws-sdk-js/3.0.0 kiro-ide/1.0.0',
    Authorization: `Bearer ${opts.apiKey}`,
    ...(opts.headers || {}),
  }
  const controller = new AbortController()
  const timeout = opts.timeoutMs
    ? setTimeout(
        () => controller.abort(new Error('Kiro request timed out')),
        opts.timeoutMs,
      )
    : null
  const signal = opts.signal
    ? AbortSignal.any([opts.signal, controller.signal])
    : controller.signal
  try {
    const response = await fetchImpl(opts.baseURL, {
      method: 'POST',
      headers,
      body: JSON.stringify(opts.body),
      signal,
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw Object.assign(
        new Error(
          `Kiro upstream error ${response.status}: ${text.slice(0, 500)}`,
        ),
        { status: response.status },
      )
    }
    const chunks: ChatCompletionChunk[] = []
    let error: Error | null = null
    await kiroEventStreamToChunks(response.body, opts.model, {
      onChunk: c => chunks.push(c),
      onError: e => {
        error = e
      },
    })
    for (const c of chunks) yield c
    if (error) throw error
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}
