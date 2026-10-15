import { randomUUID } from 'crypto'
import type { BetaRawMessageStreamEvent } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type { ChatCompletionChunk } from 'openai/resources/chat/completions/completions.mjs'
import { normalizeOpenAIUsage, type AnthropicUsage } from '@ant/model-provider'
import {
  clearChatGPTAccountFailure,
  getValidChatGPTAuth,
  markChatGPTAccountAuthRejected,
  markChatGPTAccountFailure,
  markChatGPTAccountQuotaExhausted,
} from './chatgptAuth.js'
import { routeError, routeLog } from '../../routing/stageLog.js'

/** Build a minimal valid OpenAI Responses API Response object for completion events. */
function buildCompletedResponse(
  model: string,
  outputText: string,
  status: 'completed' | 'incomplete',
): Record<string, unknown> {
  return {
    id: `resp_${randomUUID().replace(/-/g, '').slice(0, 22)}`,
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    model,
    status,
    output_text: outputText,
    output: [
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: outputText }],
        status,
      },
    ],
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      input_tokens_details: { cached_tokens: 0 },
    },
    error: null,
    incomplete_details:
      status === 'incomplete' ? { reason: 'max_tokens' } : null,
    instructions: null,
    metadata: null,
    parallel_tool_calls: true,
  }
}

type ResponsesInputItem = Record<string, unknown>
type ResponsesTool = Record<string, unknown>
const CHATGPT_ACCOUNT_FAILURE_LOG_LIMIT = 12
export type ResponsesReasoningEffort =
  | 'low'
  | 'medium'
  | 'high'
  | 'xhigh'
  | 'max'

/** Repair an upstream UTF-8 error decoded as Latin-1, without touching normal
 * non-ASCII provider messages. */
export function repairUTF8Mojibake(text: string): string {
  if (!/[\u00c0-\u00ff]/.test(text)) return text
  const repaired = new TextDecoder().decode(
    Uint8Array.from(text, char => char.charCodeAt(0)),
  )
  return repaired.includes('\ufffd') ||
    !/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(repaired)
    ? text
    : repaired
}

/** A 429 alone is transient; only an explicit subscription-cap response may
 * advance to another locally imported ChatGPT account. */
export function isChatGPTAccountQuotaExhausted(
  status: number,
  body: string,
): boolean {
  if (status !== 429) return false
  return isChatGPTSubscriptionQuota(body)
}

function isChatGPTSubscriptionQuota(body: string): boolean {
  return /usage_limit_reached|weekly (?:usage )?limit|(?:weekly|subscription) quota (?:is )?exhausted|(?:weekly|subscription) limit (?:has been )?reached|(?:you have |you've )?(?:exceeded|reached|hit) (?:your )?(?:weekly )?(?:usage )?limit/i.test(
    body,
  )
}

function quotaFailureText(event: Record<string, unknown>): string | undefined {
  if (event.type !== 'response.error' && event.type !== 'response.failed')
    return undefined
  const response = event.response as Record<string, unknown> | undefined
  const error = (event.error ?? response?.error) as unknown
  const text = JSON.stringify(error ?? event)
  return isChatGPTSubscriptionQuota(text) ? text : undefined
}

function upstreamUnavailableText(
  event: Record<string, unknown>,
): string | undefined {
  if (event.type !== 'response.error' && event.type !== 'response.failed')
    return undefined
  const response = event.response as Record<string, unknown> | undefined
  const text = JSON.stringify(event.error ?? response?.error ?? event)
  return /\b5\d\d\b|overloaded|temporarily unavailable|service unavailable|internal server error|server error|upstream.*(?:error|unavailable)/i.test(
    text,
  )
    ? text
    : undefined
}

/** Convert a direct Chat Completions fallback into the Responses event shape
 * consumed by the existing Anthropic stream adapter. */
export async function* chatCompletionsToResponses(
  stream: AsyncIterable<ChatCompletionChunk>,
  model?: string,
): AsyncGenerator<Record<string, unknown>, void> {
  const tools = new Map<number, { id: string; name: string }>()
  let completed = false
  let outputText = ''
  for await (const chunk of stream) {
    const choice = chunk.choices[0]
    if (!choice) continue
    const delta = choice.delta as typeof choice.delta & {
      reasoning_content?: string
    }
    if (delta.reasoning_content) {
      yield {
        type: 'response.reasoning_text.delta',
        delta: delta.reasoning_content,
      }
    }
    if (delta.content) {
      outputText += delta.content
      yield { type: 'response.output_text.delta', delta: delta.content }
    }
    for (const tool of delta.tool_calls ?? []) {
      const outputIndex = tool.index ?? 0
      let known = tools.get(outputIndex)
      if (!known) {
        known = {
          id: tool.id ?? `call_${outputIndex}`,
          name: tool.function?.name ?? '',
        }
        tools.set(outputIndex, known)
        yield {
          type: 'response.output_item.added',
          output_index: outputIndex,
          item: { type: 'function_call', call_id: known.id, name: known.name },
        }
      }
      if (tool.function?.arguments) {
        yield {
          type: 'response.function_call_arguments.delta',
          output_index: outputIndex,
          delta: tool.function.arguments,
        }
      }
    }
    if (choice.finish_reason) {
      for (const outputIndex of tools.keys()) {
        yield { type: 'response.output_item.done', output_index: outputIndex }
      }
      const status =
        choice.finish_reason === 'length' ? 'incomplete' : 'completed'
      yield {
        type: 'response.completed',
        response: buildCompletedResponse(
          model ?? 'unknown',
          outputText,
          status,
        ),
      }
      completed = true
      return
    }
  }
  if (!completed) {
    yield {
      type: 'response.completed',
      response: buildCompletedResponse(
        model ?? 'unknown',
        outputText,
        'completed',
      ),
    }
  }
}

type ResponsesRequest = {
  model: string
  stream: true
  store: false
  input: ResponsesInputItem[]
  instructions?: string
  tools?: ResponsesTool[]
  tool_choice?: unknown
  reasoning?: { effort: ResponsesReasoningEffort }
  parallel_tool_calls?: boolean
  /** Sticky cache routing key — stable for the CCB session. */
  prompt_cache_key: string
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(part => {
      if (!part || typeof part !== 'object') return ''
      const record = part as Record<string, unknown>
      if (typeof record.text === 'string') return record.text
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function convertUserContent(content: unknown): unknown {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return textFromContent(content)
  const result: Array<Record<string, unknown>> = []
  for (const part of content) {
    if (!part || typeof part !== 'object') continue
    const record = part as Record<string, unknown>
    if (record.type === 'text' && typeof record.text === 'string') {
      result.push({ type: 'input_text', text: record.text })
    } else if (record.type === 'image_url') {
      const imageUrl = record.image_url as Record<string, unknown> | undefined
      if (typeof imageUrl?.url === 'string') {
        result.push({ type: 'input_image', image_url: imageUrl.url })
      }
    }
  }
  return result.length > 0 ? result : textFromContent(content)
}

function convertMessagesToResponsesInput(messages: unknown[]): {
  input: ResponsesInputItem[]
  instructions?: string
} {
  const input: ResponsesInputItem[] = []
  const instructions: string[] = []

  for (const message of messages) {
    if (!message || typeof message !== 'object') continue
    const record = message as Record<string, unknown>
    const role = record.role

    if (role === 'system' || role === 'developer') {
      const text = textFromContent(record.content)
      if (text) instructions.push(text)
      continue
    }

    if (role === 'tool') {
      const callId = record.tool_call_id
      if (typeof callId === 'string') {
        input.push({
          type: 'function_call_output',
          call_id: callId,
          output: textFromContent(record.content),
        })
      }
      continue
    }

    if (role === 'assistant') {
      const text = textFromContent(record.content)
      if (text) {
        input.push({ role: 'assistant', content: text })
      }
      const toolCalls = record.tool_calls
      if (Array.isArray(toolCalls)) {
        for (const toolCall of toolCalls) {
          if (!toolCall || typeof toolCall !== 'object') continue
          const tc = toolCall as Record<string, unknown>
          const fn = tc.function as Record<string, unknown> | undefined
          const id = typeof tc.id === 'string' ? tc.id : undefined
          const name = typeof fn?.name === 'string' ? fn.name : undefined
          if (!id || !name) continue
          input.push({
            type: 'function_call',
            call_id: id,
            name,
            arguments: typeof fn?.arguments === 'string' ? fn.arguments : '{}',
          })
        }
      }
      continue
    }

    if (role === 'user') {
      input.push({
        role: 'user',
        content: convertUserContent(record.content),
      })
    }
  }

  return {
    input,
    instructions:
      instructions.length > 0 ? instructions.join('\n\n') : undefined,
  }
}

function convertToolsToResponses(tools: unknown[]): ResponsesTool[] {
  const result: ResponsesTool[] = []
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object') continue
    const record = tool as Record<string, unknown>
    const fn = record.function as Record<string, unknown> | undefined
    const name = typeof fn?.name === 'string' ? fn.name : undefined
    if (!name) continue
    result.push({
      type: 'function',
      name,
      description: typeof fn?.description === 'string' ? fn.description : '',
      parameters:
        fn?.parameters && typeof fn.parameters === 'object'
          ? fn.parameters
          : { type: 'object', properties: {} },
      strict: false,
    })
  }
  return result
}

function convertToolChoiceToResponses(toolChoice: unknown): unknown {
  if (toolChoice === 'required') return 'required'
  if (toolChoice === 'auto') return 'auto'
  if (!toolChoice || typeof toolChoice !== 'object') return toolChoice
  const record = toolChoice as Record<string, unknown>
  const fn = record.function as Record<string, unknown> | undefined
  if (record.type === 'function' && typeof fn?.name === 'string') {
    return { type: 'function', name: fn.name }
  }
  return toolChoice
}

export function buildResponsesRequest(params: {
  model: string
  messages: unknown[]
  tools: unknown[]
  toolChoice: unknown
  reasoningEffort?: ResponsesReasoningEffort
  /** Session-scoped key supplied only by the ChatGPT OAuth route. */
  promptCacheKey: string
}): ResponsesRequest {
  const { input, instructions } = convertMessagesToResponsesInput(
    params.messages,
  )
  const tools = convertToolsToResponses(params.tools)
  return {
    model: params.model,
    stream: true,
    store: false,
    input,
    ...(instructions ? { instructions } : {}),
    ...(tools.length > 0 ? { tools } : {}),
    ...(params.toolChoice
      ? { tool_choice: convertToolChoiceToResponses(params.toolChoice) }
      : {}),
    ...(params.reasoningEffort
      ? { reasoning: { effort: params.reasoningEffort } }
      : {}),
    parallel_tool_calls: true,
    // Same OAuth session → same key so OpenAI can sticky-route to a cache node.
    // Must not hash the full message list (would change every turn).
    prompt_cache_key: params.promptCacheKey,
  }
}

async function* parseSSE(
  response: Response,
  signal?: AbortSignal,
  onChunk?: () => void,
): AsyncGenerator<Record<string, unknown>, void> {
  if (!response.body) throw new Error('ChatGPT response did not include a body')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { done, value } = await readSSEChunk(reader, signal)
    if (done) break
    onChunk?.()
    buffer += decoder.decode(value, { stream: true })
    let splitAt = buffer.indexOf('\n\n')
    while (splitAt >= 0) {
      const frame = buffer.slice(0, splitAt)
      buffer = buffer.slice(splitAt + 2)
      const data = frame
        .split(/\r?\n/)
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trimStart())
        .join('\n')
      if (data && data !== '[DONE]') {
        const parsed = JSON.parse(data) as unknown
        if (parsed && typeof parsed === 'object') {
          yield parsed as Record<string, unknown>
        }
      }
      splitAt = buffer.indexOf('\n\n')
    }
  }
}

async function readSSEChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal?: AbortSignal,
): ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']> {
  if (!signal) return await reader.read()
  if (signal.aborted) throw new Error('ChatGPT Responses stream aborted')
  return await new Promise((resolve, reject) => {
    const onAbort = () => {
      void reader.cancel().catch(() => undefined)
      reject(new Error('ChatGPT Responses stream aborted'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    void reader.read().then(
      value => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      error => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

function getChatGPTResponsesTimeoutMs(): number {
  const configured = Number(process.env.CHATGPT_RESPONSES_TIMEOUT_MS)
  return Number.isFinite(configured) && configured > 0 ? configured : 30_000
}

/**
 * Map OpenAI Responses usage → Anthropic-style mutually exclusive fields.
 *
 * OpenAI:  input_tokens is TOTAL input; cached_tokens ⊆ input_tokens;
 *          cache_write_tokens (GPT-5.6+) reports tokens written this turn.
 * Anthropic: input + cache_creation + cache_read are disjoint and sum to total.
 *
 * Without subtracting cached from input, cacheWarning hit-rate becomes
 * cached/(total+cached) with a hard ceiling of 50%.
 */
export function extractUsage(
  response: Record<string, unknown> | undefined,
): AnthropicUsage {
  const usage = response?.usage as Record<string, unknown> | undefined
  const inputDetails = usage?.input_tokens_details as
    | Record<string, unknown>
    | undefined

  const totalInput =
    typeof usage?.input_tokens === 'number' ? usage.input_tokens : 0
  const outputTokens =
    typeof usage?.output_tokens === 'number' ? usage.output_tokens : 0

  const cachedRaw =
    typeof inputDetails?.cached_tokens === 'number'
      ? inputDetails.cached_tokens
      : 0
  const writeRaw =
    typeof inputDetails?.cache_write_tokens === 'number'
      ? inputDetails.cache_write_tokens
      : 0

  return normalizeOpenAIUsage({
    totalInputTokens: totalInput,
    outputTokens,
    cacheReadTokens: cachedRaw,
    cacheWriteTokens: writeRaw,
  })
}

function mapStopReason(response: Record<string, unknown> | undefined): string {
  if (response?.status === 'incomplete') return 'max_tokens'
  return 'end_turn'
}

export async function* adaptResponsesStreamToAnthropic(
  stream: AsyncIterable<Record<string, unknown>>,
  model: string,
): AsyncGenerator<BetaRawMessageStreamEvent, void> {
  const messageId = `msg_${randomUUID().replace(/-/g, '').slice(0, 24)}`
  const toolBlocks = new Map<
    number,
    { contentIndex: number; open: boolean; name: string; id: string }
  >()
  let started = false
  let currentContentIndex = -1
  let textBlockOpen = false
  let thinkingBlockOpen = false

  const ensureStarted = async function* () {
    if (started) return
    started = true
    yield {
      type: 'message_start',
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        content: [],
        model,
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    } as unknown as BetaRawMessageStreamEvent
  }

  for await (const event of stream) {
    for await (const startedEvent of ensureStarted()) yield startedEvent
    const type = event.type

    if (type === 'response.output_text.delta') {
      if (!textBlockOpen) {
        if (thinkingBlockOpen) {
          yield {
            type: 'content_block_stop',
            index: currentContentIndex,
          } as BetaRawMessageStreamEvent
          thinkingBlockOpen = false
        }
        currentContentIndex++
        textBlockOpen = true
        yield {
          type: 'content_block_start',
          index: currentContentIndex,
          content_block: { type: 'text', text: '' },
        } as BetaRawMessageStreamEvent
      }
      yield {
        type: 'content_block_delta',
        index: currentContentIndex,
        delta: { type: 'text_delta', text: String(event.delta ?? '') },
      } as BetaRawMessageStreamEvent
      continue
    }

    if (type === 'response.reasoning_text.delta') {
      if (!thinkingBlockOpen) {
        if (textBlockOpen) {
          yield {
            type: 'content_block_stop',
            index: currentContentIndex,
          } as BetaRawMessageStreamEvent
          textBlockOpen = false
        }
        currentContentIndex++
        thinkingBlockOpen = true
        yield {
          type: 'content_block_start',
          index: currentContentIndex,
          content_block: { type: 'thinking', thinking: '', signature: '' },
        } as BetaRawMessageStreamEvent
      }
      yield {
        type: 'content_block_delta',
        index: currentContentIndex,
        delta: { type: 'thinking_delta', thinking: String(event.delta ?? '') },
      } as BetaRawMessageStreamEvent
      continue
    }

    if (type === 'response.output_item.added') {
      const item = event.item as Record<string, unknown> | undefined
      const outputIndex =
        typeof event.output_index === 'number' ? event.output_index : -1
      if (item?.type === 'function_call' && outputIndex >= 0) {
        if (textBlockOpen) {
          yield {
            type: 'content_block_stop',
            index: currentContentIndex,
          } as BetaRawMessageStreamEvent
          textBlockOpen = false
        }
        if (thinkingBlockOpen) {
          yield {
            type: 'content_block_stop',
            index: currentContentIndex,
          } as BetaRawMessageStreamEvent
          thinkingBlockOpen = false
        }
        currentContentIndex++
        const id = String(item.call_id ?? item.id ?? `call_${outputIndex}`)
        const name = String(item.name ?? '')
        toolBlocks.set(outputIndex, {
          contentIndex: currentContentIndex,
          open: true,
          name,
          id,
        })
        yield {
          type: 'content_block_start',
          index: currentContentIndex,
          content_block: { type: 'tool_use', id, name, input: {} },
        } as BetaRawMessageStreamEvent
      }
      continue
    }

    if (type === 'response.function_call_arguments.delta') {
      const outputIndex =
        typeof event.output_index === 'number' ? event.output_index : -1
      const block = toolBlocks.get(outputIndex)
      if (block) {
        yield {
          type: 'content_block_delta',
          index: block.contentIndex,
          delta: {
            type: 'input_json_delta',
            partial_json: String(event.delta ?? ''),
          },
        } as BetaRawMessageStreamEvent
      }
      continue
    }

    if (type === 'response.output_item.done') {
      const outputIndex =
        typeof event.output_index === 'number' ? event.output_index : -1
      const block = toolBlocks.get(outputIndex)
      if (block?.open) {
        yield {
          type: 'content_block_stop',
          index: block.contentIndex,
        } as BetaRawMessageStreamEvent
        block.open = false
      }
      continue
    }

    if (type === 'response.error') {
      const error = event.error as Record<string, unknown> | undefined
      throw new Error(
        repairUTF8Mojibake(
          String(error?.message ?? 'ChatGPT Responses API error'),
        ),
      )
    }

    if (type === 'response.failed') {
      const response = event.response as Record<string, unknown> | undefined
      const error = response?.error as Record<string, unknown> | undefined
      throw new Error(
        repairUTF8Mojibake(
          String(error?.message ?? 'ChatGPT Responses API failed'),
        ),
      )
    }

    if (type === 'response.completed' || type === 'response.incomplete') {
      if (textBlockOpen) {
        yield {
          type: 'content_block_stop',
          index: currentContentIndex,
        } as BetaRawMessageStreamEvent
        textBlockOpen = false
      }
      if (thinkingBlockOpen) {
        yield {
          type: 'content_block_stop',
          index: currentContentIndex,
        } as BetaRawMessageStreamEvent
        thinkingBlockOpen = false
      }
      const response = event.response as Record<string, unknown> | undefined
      yield {
        type: 'message_delta',
        delta: { stop_reason: mapStopReason(response), stop_sequence: null },
        usage: extractUsage(response),
      } as unknown as BetaRawMessageStreamEvent
      yield { type: 'message_stop' } as BetaRawMessageStreamEvent
    }
  }
}

export async function* createChatGPTResponsesStream(params: {
  request: ResponsesRequest
  signal: AbortSignal
  fetchOverride?: typeof fetch
  onAccountExhausted?: () => AsyncIterable<Record<string, unknown>>
  onAccountUnavailable?: () => AsyncIterable<Record<string, unknown>>
}): AsyncGenerator<Record<string, unknown>, void> {
  const fetchFn = params.fetchOverride ?? (globalThis.fetch as typeof fetch)
  const attempted = new Set<string>()
  const rejected = new Set<string>()
  let lastError: Error | undefined
  let failureLogsSuppressed = false

  const logAccountFailure = (
    message: string,
    details: Record<string, unknown>,
  ) => {
    if (attempted.size <= CHATGPT_ACCOUNT_FAILURE_LOG_LIMIT) {
      routeError(message, details)
      return
    }
    if (!failureLogsSuppressed) {
      failureLogsSuppressed = true
      routeError('codex account failures suppressed', {
        attempted: attempted.size,
      })
    }
  }

  // Retry only account-specific auth failures. In particular, a generic 429
  // must not rotate the pool: it does not prove another account can serve it.
  while (true) {
    let auth
    try {
      while (true) {
        auth = await getValidChatGPTAuth()
        if (!auth.accountId || !rejected.has(auth.accountId)) break
        markChatGPTAccountFailure(auth)
      }
    } catch (error) {
      if (params.onAccountExhausted) {
        routeLog('request', 'codex unavailable; auto fallback', {
          attempts: attempted.size,
        })
        yield* params.onAccountExhausted()
        return
      }
      routeError('codex account unavailable', {
        attempts: attempted.size,
        errorType: error instanceof Error ? error.name : typeof error,
      })
      throw lastError ?? error
    }
    if (!auth.accountId || attempted.has(auth.accountId)) {
      if (params.onAccountExhausted) {
        routeLog('request', 'codex pool exhausted; auto fallback', {
          attempts: attempted.size,
        })
        yield* params.onAccountExhausted()
        return
      }
      routeError('codex account pool exhausted', { attempts: attempted.size })
      throw lastError ?? new Error('No ChatGPT account could start a response.')
    }
    attempted.add(auth.accountId)
    rejected.add(auth.accountId)
    routeLog('request', 'codex request', {
      account: auth.accountId,
      model: params.request.model,
      attempt: attempted.size,
    })
    const headers: Record<string, string> = {
      Authorization: `Bearer ${auth.accessToken}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      'OpenAI-Beta': 'responses=experimental',
      Origin: 'https://chatgpt.com',
      Referer: 'https://chatgpt.com/',
      originator: 'claude-code-best',
      'ChatGPT-Account-Id': auth.accountId,
    }
    const controller = new AbortController()
    let timedOut = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const resetTimeout = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timedOut = true
        controller.abort()
      }, getChatGPTResponsesTimeoutMs())
    }
    const clearRequestTimeout = () => {
      if (timer) clearTimeout(timer)
      timer = undefined
    }
    resetTimeout()
    const abort = () => controller.abort()
    params.signal.addEventListener('abort', abort, { once: true })
    let response: Response
    try {
      response = await fetchFn(
        'https://chatgpt.com/backend-api/codex/responses',
        {
          method: 'POST',
          headers,
          body: JSON.stringify(params.request),
          signal: controller.signal,
        },
      )
    } catch (error) {
      clearRequestTimeout()
      params.signal.removeEventListener('abort', abort)
      if (params.signal.aborted) {
        routeLog('request', 'codex request cancelled', {
          account: auth.accountId,
          phase: 'request',
        })
        throw error
      }
      logAccountFailure(
        timedOut ? 'codex request timed out' : 'codex request failed',
        {
          account: auth.accountId,
          phase: 'request',
          contentStarted: false,
          timeoutMs: timedOut ? getChatGPTResponsesTimeoutMs() : undefined,
          errorType: error instanceof Error ? error.name : typeof error,
        },
      )
      if (timedOut && params.onAccountUnavailable) {
        routeLog('request', 'codex -> auto fallback (timeout)')
        yield* params.onAccountUnavailable()
        return
      }
      markChatGPTAccountFailure(auth)
      continue
    }
    if (response.ok) {
      routeLog('request', 'codex response', {
        account: auth.accountId,
        status: response.status,
      })
      let contentStarted = false
      let rotate = false
      let quotaExhausted = false
      try {
        for await (const event of parseSSE(
          response,
          controller.signal,
          resetTimeout,
        )) {
          const unavailable = upstreamUnavailableText(event)
          if (unavailable && !contentStarted && params.onAccountUnavailable) {
            lastError = new Error(
              `ChatGPT upstream unavailable: ${unavailable}`,
            )
            routeLog(
              'request',
              'codex -> auto fallback (SSE upstream unavailable)',
            )
            yield* params.onAccountUnavailable()
            return
          }
          const quotaError = quotaFailureText(event)
          if (quotaError) {
            quotaExhausted = true
            lastError = new Error(
              `ChatGPT subscription quota exhausted: ${quotaError}`,
            )
            await markChatGPTAccountQuotaExhausted(auth, fetchFn)
            logAccountFailure('codex subscription quota exhausted', {
              account: auth.accountId,
            })
            if (contentStarted) throw lastError
            rotate = true
            break
          }
          contentStarted ||=
            event.type === 'response.output_text.delta' ||
            event.type === 'response.reasoning_text.delta' ||
            event.type === 'response.output_item.added'
          yield event
        }
      } catch (error) {
        if (params.signal.aborted) {
          routeLog('request', 'codex response stream cancelled', {
            account: auth.accountId,
            phase: 'stream',
            contentStarted,
          })
          throw error
        }
        if (quotaExhausted) throw error
        lastError =
          error instanceof Error
            ? error
            : new Error('ChatGPT Responses stream failed')
        logAccountFailure(
          timedOut
            ? 'codex response stream timed out'
            : 'codex response stream failed',
          {
            account: auth.accountId,
            phase: 'stream',
            contentStarted,
            timeoutMs: timedOut ? getChatGPTResponsesTimeoutMs() : undefined,
            errorType: error instanceof Error ? error.name : typeof error,
          },
        )
        if (timedOut && !contentStarted && params.onAccountUnavailable) {
          routeLog('request', 'codex -> auto fallback (stream timeout)')
          yield* params.onAccountUnavailable()
          return
        }
        if (contentStarted) throw lastError
        markChatGPTAccountFailure(auth)
        continue
      } finally {
        clearRequestTimeout()
        params.signal.removeEventListener('abort', abort)
      }
      if (rotate) continue
      if (!contentStarted) {
        lastError = new Error('ChatGPT Responses API returned an empty stream')
        markChatGPTAccountFailure(auth)
        logAccountFailure('codex returned empty stream', {
          account: auth.accountId,
        })
        continue
      }
      clearChatGPTAccountFailure(auth)
      rejected.delete(auth.accountId)
      routeLog('request', 'codex response complete', {
        account: auth.accountId,
      })
      return
    }

    clearRequestTimeout()
    params.signal.removeEventListener('abort', abort)
    const text = repairUTF8Mojibake(await response.text().catch(() => ''))
    lastError = new Error(
      `ChatGPT Responses API request failed (${response.status})${text ? `: ${text.slice(0, 500)}` : ''}`,
    )
    if (response.status >= 500 && params.onAccountUnavailable) {
      routeLog('request', 'codex -> auto fallback (upstream unavailable)', {
        status: response.status,
      })
      yield* params.onAccountUnavailable()
      return
    }
    if (
      response.status !== 401 &&
      response.status !== 403 &&
      !isChatGPTAccountQuotaExhausted(response.status, text)
    ) {
      routeError('codex request rejected', {
        account: auth.accountId,
        status: response.status,
      })
      throw lastError
    }
    if (isChatGPTAccountQuotaExhausted(response.status, text)) {
      await markChatGPTAccountQuotaExhausted(auth, fetchFn)
    } else {
      await markChatGPTAccountAuthRejected(auth)
    }
    logAccountFailure('codex account rejected', {
      account: auth.accountId,
      status: response.status,
    })
  }
}
