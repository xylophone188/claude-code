import type {
  ChatCompletionChunk,
  ChatCompletionCreateParamsStreaming,
} from 'openai/resources/chat/completions/completions.mjs'
import type {
  BetaToolUnion,
  BetaMessage,
  BetaUsage,
} from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'
import type { SystemPrompt } from '../../../utils/systemPromptType.js'
import type {
  Message,
  StreamEvent,
  SystemAPIErrorMessage,
  AssistantMessage,
  UserMessage,
} from '../../../types/message.js'
import type { AgentId } from '../../../types/ids.js'
import type { Tools } from '../../../Tool.js'
import { getSessionId } from '../../../bootstrap/state.js'
import {
  getOpencodeModelName,
  isOpencodeModel,
} from '../../../utils/model/model.js'
import { getAPIProvider } from '../../../utils/model/providers.js'
import { resolveAppliedEffort } from '../../../utils/effort.js'
import {
  isCCBModel,
  isCCBRoutingModel,
} from '../../../utils/model/opencodeFree.js'
import {
  CHATGPT_CODEX_DEFAULT_MODEL,
  isChatGPTAuthMode,
  isChatGPTCodexReasoningModel,
} from '../../../utils/model/chatgptModels.js'
import { getOpenAIClient } from './client.js'
import {
  getLocalFallbackConfig,
  getOmniRouteConfig,
  resolveDirectRoutes,
  type DirectRoute,
} from '../../omniroute/adapter.js'
import {
  clearAccountFailure,
  clearModelFailure,
  isProviderFailure,
  isModelFailure,
  markAccountFailure,
  markModelFailure,
  markProviderFailure,
  waitForProviderRequestSlot,
} from '../../omniroute/adapter.js'
import { API_ERROR_MESSAGE_PREFIX } from '../errors.js'
import {
  beginCcbRoute,
  classifyError,
  classifyErrorStatus,
  isGatewayUnavailable,
  recordRaceMetric,
  setActiveCcbRoute,
} from '../../omniroute/adapter.js'
import { fuseAnswers, type PanelAnswer } from '../../routing/fusion.js'
import {
  invalidateOpenCodeModelsCache,
  refreshAutoHealth,
  currentFreeOpenCodeModels,
} from '../../routing/autoScoring.js'
import { applyCompatRule } from '../../providerRegistry/providerCompatMatrix.js'
import { buildDirectRacePool } from '../../routing/directRacePool.js'
import { routeError, routeLog } from '../../routing/stageLog.js'
import {
  isJunkContent,
  isFakeSuccessBody,
} from '../../routing/responseQuality.js'
import {
  validateVisionResponse,
  containsVisionInput,
} from '../../routing/visionQuality.js'
import {
  isCircuitOpen,
  recordCircuitFailure,
  recordCircuitSuccess,
} from '../../routing/circuitBreaker.js'
import {
  isAccountAdmitted,
  isModelAdmitted,
  isProviderAdmitted,
  recordAccountNotAdmitted,
  recordModelNotAdmitted,
  recordProviderNotAdmitted,
} from '../../routing/admission.js'
import {
  formatOpenAIPromptCacheKey,
  getOfficialOpenAIPromptCacheKey,
  updateOpenAIUsage,
} from './openaiShared.js'
import {
  matchUpstreamCustomError,
  UpstreamBlockedError,
} from './upstreamBlockedError.js'
import {
  anthropicMessagesToOpenAI,
  resolveOpenAIModel,
  adaptOpenAIStreamToAnthropic,
  anthropicToolsToOpenAI,
  anthropicToolChoiceToOpenAI,
} from '@ant/model-provider'
import { isChatGPTAuthEnabled } from './chatgptAuth.js'
import { createKiroStream } from './translators/kiro.js'
import {
  getCopilotToken,
  invalidateCopilotToken,
} from './translators/github.js'
import {
  adaptResponsesStreamToAnthropic,
  buildResponsesRequest,
  chatCompletionsToResponses,
  createChatGPTResponsesStream,
  repairUTF8Mojibake,
  type ResponsesReasoningEffort,
} from './responsesAdapter.js'
import { normalizeMessagesForAPI } from '../../../utils/messages.js'
import { toolToAPISchema } from '../../../utils/api.js'
import {
  getEmptyToolPermissionContext,
  toolMatchesName,
} from '../../../Tool.js'
import { logForDebugging } from '../../../utils/debug.js'
import { addToTotalSessionCost } from '../../../cost-tracker.js'
import { calculateUSDCost } from '../../../utils/modelCost.js'
import {
  isOpenAIThinkingEnabled,
  resolveOpenAIMaxTokens,
  buildOpenAIRequestBody,
  sanitizeNvidiaRequestBody,
  sanitizeCodeBuddyRequestBody,
  clampReasoningEffort,
} from './requestBody.js'
import { recordLLMObservation } from '../../../services/langfuse/tracing.js'
import {
  convertMessagesToLangfuse,
  convertOutputToLangfuse,
  convertToolsToLangfuse,
} from '../../../services/langfuse/convert.js'
export {
  isOpenAIThinkingEnabled,
  resolveOpenAIMaxTokens,
  buildOpenAIRequestBody,
}
import { getModelMaxOutputTokens } from '../../../utils/context.js'
import type { Options } from '../claude.js'
import { randomUUID } from 'crypto'
import {
  createAssistantAPIErrorMessage,
  createUserMessage,
  normalizeContentFromAPI,
} from '../../../utils/messages.js'
import type { SDKAssistantMessageError } from '../../../entrypoints/agentSdkTypes.js'
import {
  isSearchExtraToolsEnabled,
  isDeferredToolsDeltaEnabled,
} from '../../../utils/searchExtraTools.js'
import {
  formatDeferredToolLine,
  isDeferredTool,
  SEARCH_EXTRA_TOOLS_TOOL_NAME,
} from '@claude-code-best/builtin-tools/tools/SearchExtraToolsTool/prompt.js'
import { APIUserAbortError } from '@anthropic-ai/sdk/error'

const LOCAL_CODEX_ADVISOR = '__ccb_local_codex_advisor__'

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new APIUserAbortError()
}

function waitForRaceDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  if (!delayMs) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, delayMs)
    function done(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      resolve()
    }
    function abort(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      reject(new APIUserAbortError())
    }
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  })
}

export function waitForBackoff(
  delayMs: number,
  signal: AbortSignal,
): Promise<void> {
  if (!delayMs) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, delayMs)
    function done(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      resolve()
    }
    function abort(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      reject(new APIUserAbortError())
    }
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
  })
}

function convertToResponsesReasoningEffort(
  effortValue: unknown,
): ResponsesReasoningEffort | undefined {
  if (effortValue === 'low') return 'low'
  if (effortValue === 'medium') return 'medium'
  if (effortValue === 'high') return 'high'
  if (effortValue === 'xhigh') return 'xhigh'
  if (effortValue === 'max') return 'max'
  if (typeof effortValue === 'number') return 'high'
  return undefined
}

function getChatGPTResponsesReasoningEffort(
  effortValue: unknown,
): ResponsesReasoningEffort | undefined {
  const envOverride = process.env.CLAUDE_CODE_EFFORT_LEVEL?.toLowerCase()
  if (envOverride === 'auto' || envOverride === 'unset') return undefined
  return (
    convertToResponsesReasoningEffort(envOverride) ??
    convertToResponsesReasoningEffort(effortValue) ??
    'medium'
  )
}

/**
 * Mirrors the Anthropic request path's deferred-tool announcement for OpenAI.
 *
 * OpenAI-compatible endpoints cannot consume Anthropic's `defer_loading` or
 * `tool_reference` beta payloads directly, so the model needs the same textual
 * list of deferred MCP tool names that Anthropic receives before it can ask
 * SearchExtraToolsTool to load their full schemas.
 */
function prependDeferredToolListIfNeeded(
  messages: (AssistantMessage | UserMessage)[],
  tools: Tools,
  deferredToolNames: Set<string>,
  useSearchExtraTools: boolean,
): (AssistantMessage | UserMessage)[] {
  if (!useSearchExtraTools || isDeferredToolsDeltaEnabled()) return messages

  const deferredToolList = tools
    .filter(tool => deferredToolNames.has(tool.name))
    .map(formatDeferredToolLine)
    .sort()
    .join('\n')

  if (!deferredToolList) return messages

  return [
    createUserMessage({
      content: `<available-deferred-tools>\n${deferredToolList}\n</available-deferred-tools>`,
      isMeta: true,
    }),
    ...messages,
  ]
}

const OPENCODE_FREE_BASE_URL =
  process.env.OPENCODE_ZEN_BASE_URL ?? 'https://opencode.ai/zen/v1'
const OPENCODE_FREE_RETRIES = 11 // 1 initial + 10 immediate retries
const DIRECT_ROUTE_RETRIES = 11 // 1 initial + 10 retries for transient upstream failures
const OMNIROUTE_RETRIES = 6 // 1 initial + 5 retries
const OMNIROUTE_INITIAL_BACKOFF_MS = 1_000
const OMNIROUTE_MAX_BACKOFF_MS = 16_000
const CUSTOM_ROUTE_RETRIES = 3 // Safe: events are buffered until the stream completes.
const GATEWAY_RETRIES = 6 // 1 initial + 5 slow retries (~31s) for gateway-wide outages
const ADVISOR_AUTO_MAX_TOKENS = 8_192
const AUTO_TIER_TTFS_TIMEOUT_MS = [
  4_000, 8_000, 12_000, 16_000, 20_000, 24_000,
] as const

export function autoTierTtfsTimeoutMs(level: number): number {
  return (
    AUTO_TIER_TTFS_TIMEOUT_MS[
      Math.min(Math.max(level, 1), AUTO_TIER_TTFS_TIMEOUT_MS.length) - 1
    ] ?? AUTO_TIER_TTFS_TIMEOUT_MS[5]
  )
}

const AUTO_L1_RACE_TIMEOUT_MS =
  Number(process.env.CCB_AUTO_L1_RACE_TIMEOUT_MS) ||
  AUTO_TIER_TTFS_TIMEOUT_MS[0]
/**
 * L1 race quorum: at least half (rounded up, minimum 1) of the raced routes
 * must produce a complete, valid result before the race picks a winner. The
 * winner is chosen from complete results only — a stream is not a candidate
 * until it ends with real content or a well-formed tool call, so empty,
 * whitespace-only, fake-200, or truncated tool-call streams never win.
 */
function raceAllOfMode(): 'best' | 'vote' | 'concat' | false {
  const raw = process.env.CCB_RACE_ALL_OF
  if (!raw) return false
  if (raw === '1' || raw === 'best') return 'best'
  if (raw === 'vote') return 'vote'
  if (raw === 'concat') return 'concat'
  return false
}

function isMeaningfulOpenAIEvent(event: ChatCompletionChunk): boolean {
  const choice = event.choices[0]
  if (!choice) return false
  const delta = choice.delta
  const content = typeof delta.content === 'string' ? delta.content.trim() : ''
  const reasoning = (
    (delta as { reasoning_content?: string }).reasoning_content ?? ''
  ).trim()
  return Boolean(content || reasoning || delta.tool_calls?.length)
}

/** Race gate: reasoning-only deltas do not count. Reasoning-first models can
 *  emit their first thinking chunk in <1s but leave the user staring at a
 *  blank pane for 10s+ before any visible content — a race won on a
 *  reasoning delta is a race won by the wrong leg. */
function isContentfulOpenAIEvent(event: ChatCompletionChunk): boolean {
  const choice = event.choices[0]
  if (!choice) return false
  const delta = choice.delta
  const content = typeof delta.content === 'string' ? delta.content.trim() : ''
  return Boolean(content || delta.tool_calls?.length)
}

function eventText(event: ChatCompletionChunk): string {
  const delta = event.choices[0]?.delta
  const reasoning = (delta as { reasoning_content?: unknown } | undefined)
    ?.reasoning_content
  return typeof delta?.content === 'string'
    ? delta.content
    : typeof reasoning === 'string'
      ? reasoning
      : ''
}

function eventToolCalls(event: ChatCompletionChunk): number {
  return event.choices[0]?.delta.tool_calls?.length ?? 0
}

function isDsmlStart(text: string): boolean {
  return /<(?:｜｜|｜)DSML(?:｜｜|｜)tool_calls>/.test(text)
}

function isDsmlComplete(text: string): boolean {
  return /<\/(?:｜｜|｜)DSML(?:｜｜|｜)tool_calls>/.test(text)
}

/**
 * Incrementally accumulate streamed text; throw `UpstreamBlockedError` as soon
 * as the running text matches an upstream custom-error pattern (HTTP 200 whose
 * body is actually a gateway error string). Streaming makes a blocked provider
 * fail fast instead of delivering its whole error body to the user.
 */
function throwIfUpstreamBlocked(
  event: ChatCompletionChunk,
  acc: { text: string },
): void {
  const delta = event.choices?.[0]?.delta
  const chunk =
    delta?.content ??
    (delta as { reasoning_content?: string } | undefined)?.reasoning_content
  if (typeof chunk !== 'string') return
  acc.text += chunk
  const blocked = matchUpstreamCustomError(acc.text)
  if (blocked) throw new UpstreamBlockedError(blocked)
}

/** Convert DeepSeek's textual DSML tool call into standard OpenAI tool_calls. */
function normalizeDsmlEvents(
  events: ChatCompletionChunk[],
  text: string,
): ChatCompletionChunk[] {
  const header = text.match(/<(?:｜｜|｜)DSML(?:｜｜|｜)tool_calls>/)
  if (!header) return events
  const invoke = text.match(
    /<(?:｜｜|｜)DSML(?:｜｜|｜)invoke\s+name=["']([^"']+)["']\s*>([\s\S]*?)<\/(?:｜｜|｜)DSML(?:｜｜|｜)invoke>/,
  )
  if (!invoke) return events
  const args: Record<string, string> = {}
  const parameterRe =
    /<(?:｜｜|｜)DSML(?:｜｜|｜)parameter\s+name=["']([^"']+)["'][^>]*>([\s\S]*?)<\/(?:｜｜|｜)DSML(?:｜｜|｜)parameter>/g
  for (const match of invoke[2].matchAll(parameterRe))
    args[match[1]] = match[2].trim()
  const cleaned = text.slice(0, text.indexOf(header[0])).trim()
  const base =
    events[0] ??
    ({ id: `dsml-${Date.now()}`, model: 'unknown' } as ChatCompletionChunk)
  return [
    {
      ...base,
      choices: [
        {
          index: 0,
          finish_reason: 'tool_calls',
          delta: {
            ...(cleaned ? { content: cleaned } : {}),
            tool_calls: [
              {
                index: 0,
                id: `call_dsml_${Date.now()}`,
                type: 'function',
                function: { name: invoke[1], arguments: JSON.stringify(args) },
              },
            ],
          },
        },
      ],
    } as ChatCompletionChunk,
  ]
}

class ProviderOutputError extends Error {
  override name = 'ProviderOutputError'
}

export async function* retryOpencodeFreeStream(
  createStream: () => Promise<AsyncIterable<ChatCompletionChunk>>,
  signal?: AbortSignal,
): AsyncGenerator<Record<string, unknown>, void> {
  let lastError: unknown
  for (let attempt = 1; attempt <= OPENCODE_FREE_RETRIES; attempt++) {
    if (signal) throwIfAborted(signal)
    try {
      const events: ChatCompletionChunk[] = []
      let meaningful = false
      const streamText = { text: '' }
      for await (const event of await createStream()) {
        events.push(event)
        meaningful ||= isMeaningfulOpenAIEvent(event)
        throwIfUpstreamBlocked(event, streamText)
      }
      if (!meaningful) throw new Error('opencode-free returned an empty stream')
      if (isFakeSuccessBody(streamText.text)) {
        throw new ProviderOutputError(
          'opencode-free returned a fake-success body',
        )
      }
      if (isJunkContent(streamText.text)) {
        throw new ProviderOutputError(
          'opencode-free returned invalid provider text',
        )
      }
      yield* normalizeDsmlEvents(events, streamText.text) as unknown as Array<
        Record<string, unknown>
      >
      return
    } catch (error) {
      if (signal?.aborted) throw new APIUserAbortError()
      lastError = error
      // Bad model output is deterministic enough to avoid ten extra requests.
      if (error instanceof ProviderOutputError) throw error
      if (attempt === OPENCODE_FREE_RETRIES) throw error
    }
  }
  throw lastError
}

function routeFailureScope(error: unknown): 'provider' | 'model' | 'account' {
  const { scope } = classifyError(error)
  return scope
}

export function isLocalFallbackEligible(error: unknown): boolean {
  if (error instanceof ProviderOutputError) return false
  const status = (error as { status?: number } | undefined)?.status
  if (status === 502 || status === 503 || status === 504) return true
  if (status !== undefined) return false
  const details = [
    (error as { code?: string } | undefined)?.code,
    (error as { name?: string } | undefined)?.name,
    (error as { message?: string } | undefined)?.message,
  ].join(' ')
  if (/quota|balance|credits?|insufficient|rate.?limit/i.test(details))
    return false
  return /ECONNREFUSED|ECONNRESET|ENETUNREACH|EAI_AGAIN|ETIMEDOUT|timeout|deadline|network error|connection error/i.test(
    details,
  )
}

function isOmniRouteTransientError(error: unknown): boolean {
  if (error instanceof ProviderOutputError) return false
  const status = (error as { status?: number } | undefined)?.status
  // Gateway capacity exhaustion is advisory: the pool restores itself once the
  // upstream accounts recover, so treat it like the 502 gateway outage path.
  if (status === 429) return true
  if (status !== undefined && status < 500) return false
  if (status !== undefined && status >= 500) return true
  const errorDetails = [
    (error as { code?: string } | undefined)?.code,
    (error as { message?: string } | undefined)?.message,
  ].join(' ')
  return /connection error|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENETUNREACH/i.test(
    errorDetails,
  )
}

function omniRouteBackoffMs(attempt: number): number {
  return Math.min(
    OMNIROUTE_MAX_BACKOFF_MS,
    OMNIROUTE_INITIAL_BACKOFF_MS * 2 ** (attempt - 1),
  )
}

type RetryBackoff = (delayMs: number, signal: AbortSignal) => Promise<void>

/** Retry delay in ms, honoring the `retry-after` header (seconds or HTTP
 *  date) and clamping to the gateway backoff ceiling so a stale or adversarial
 *  value cannot stall the whole request for minutes. */
function retryAfterMs(error: unknown): number | undefined {
  const headers = (
    error as {
      headers?: {
        get?: (name: string) => string | null
        'retry-after'?: string
      }
    }
  ).headers
  const retryAfter = headers?.['retry-after'] ?? headers?.get?.('retry-after')
  if (retryAfter == null) return undefined

  const seconds = Number(retryAfter)
  if (Number.isFinite(seconds) && seconds >= 0)
    return Math.min(seconds * 1000, OMNIROUTE_MAX_BACKOFF_MS)

  const retryAt = Date.parse(retryAfter)
  if (Number.isNaN(retryAt)) return undefined
  return Math.min(Math.max(0, retryAt - Date.now()), OMNIROUTE_MAX_BACKOFF_MS)
}

function isInvalidProviderText(text: string): boolean {
  return isFakeSuccessBody(text) || isJunkContent(text)
}

function hasMeaningfulContent(text: string): boolean {
  return text.trim().length > 0 && !isInvalidProviderText(text)
}

/** Strip credentials from an untrusted upstream error before it reaches the UI
 *  or the conversation history (which may be re-sent to a model). Upstream text
 *  may embed raw API keys or userinfo credentials, not just Authorization
 *  headers, so scrub key-shaped tokens and userinfo too. */
function redactErrorText(text: string): string {
  return text
    .replace(/Bearer\s+\S+/gi, 'Bearer <redacted>')
    .replace(/\bsk[-_][A-Za-z0-9_-]*[A-Za-z0-9]{8}\b/g, 'sk-<redacted>')
    .replace(/([a-z]+:\/\/)[\w.-]+:[^\s@]+@/gi, '$1<redacted>@')
    .slice(0, 200)
}

export function describeUpstreamFailure(error: unknown): {
  content: string
  error: SDKAssistantMessageError
} {
  // Upstream gateway errors are frequently plain objects shaped like
  // { status, message } rather than Error instances.
  const rawMessage =
    typeof (error as { message?: unknown } | null)?.message === 'string'
      ? (error as { message: string }).message
      : String(error)
  if (
    isGatewayUnavailable(error) ||
    /all gateway backends unavailable|gateway_unavailable|all configured gateway backends failed/i.test(
      rawMessage,
    )
  ) {
    return {
      content: `${API_ERROR_MESSAGE_PREFIX}: Gateway is unavailable — all backend accounts are exhausted. Wait for capacity to recover and retry.`,
      error: 'server_error',
    }
  }
  const classification = classifyError(error)
  const status = classification.status
  const statusSuffix = status !== undefined ? ` (HTTP ${status})` : ''
  switch (classification.reason) {
    case 'rate_limit':
    case 'quota_exceeded':
      return {
        content: `${API_ERROR_MESSAGE_PREFIX}: Request rate limited${statusSuffix} — upstream quota exhausted. Retry later.`,
        error: 'rate_limit',
      }
    case 'auth_invalid':
      return {
        content: `${API_ERROR_MESSAGE_PREFIX}: Upstream credentials rejected${statusSuffix}.`,
        error: 'authentication_failed',
      }
    case 'timeout':
      return {
        content: `${API_ERROR_MESSAGE_PREFIX}: Request timed out — no response from the upstream provider.`,
        error: 'server_error',
      }
    case 'network':
      return {
        content: `${API_ERROR_MESSAGE_PREFIX}: Network error reaching the upstream provider.`,
        error: 'server_error',
      }
    case 'model_output':
      return {
        content: `${API_ERROR_MESSAGE_PREFIX}: Upstream returned unusable output.`,
        error: 'invalid_request',
      }
    default: {
      const errorMessage = redactErrorText(rawMessage)
      if (classification.reason === 'server_error') {
        return {
          content: `${API_ERROR_MESSAGE_PREFIX}: Upstream provider returned HTTP ${status ?? 'error'}${errorMessage ? ` — ${errorMessage}` : ''}`,
          error: 'server_error',
        }
      }
      return {
        content: `${API_ERROR_MESSAGE_PREFIX}: ${errorMessage || 'upstream request failed'}`,
        error: 'unknown',
      }
    }
  }
}

export async function* retryDirectProviderStream(
  routes: DirectRoute[],
  createStream: (
    route: DirectRoute,
  ) => Promise<AsyncIterable<ChatCompletionChunk>>,
  signal: AbortSignal,
  onFirstMeaningful?: () => void,
  isVisionRequest = false,
  waitForBackoff: RetryBackoff = waitForRaceDelay,
): AsyncGenerator<ChatCompletionChunk, void> {
  let lastError: unknown
  const skippedProviders = new Set<string>()
  const skippedModels = new Set<string>()
  const skippedAccounts = new Set<string>()
  for (const route of routes) {
    const modelKey = `${route.providerId}/${route.model}`
    const accountKey = route.accountId
      ? `${route.providerId}/${route.accountId}`
      : undefined
    // Circuit-breaker check: skip routes whose provider/model/account
    // circuit is currently open (ported from routing/circuitBreaker).
    if (
      isCircuitOpen('provider', route.providerId) ||
      isCircuitOpen('model', route.providerId, route.model) ||
      (accountKey !== undefined &&
        isCircuitOpen('account', route.providerId, undefined, route.accountId))
    )
      continue
    // Admission check: 401/403/404 rejections are permanent within their
    // window, so skip the route before spending a request slot on it.
    if (
      !isProviderAdmitted(route.providerId) ||
      !isModelAdmitted(route.providerId, route.model) ||
      (route.accountId !== undefined &&
        !isAccountAdmitted(route.providerId, route.accountId))
    )
      continue
    if (
      skippedProviders.has(route.providerId) ||
      isProviderFailure(route.providerId) ||
      skippedModels.has(modelKey) ||
      isModelFailure(route.providerId, route.model) ||
      (accountKey && skippedAccounts.has(accountKey))
    )
      continue
    throwIfAborted(signal)
    await waitForProviderRequestSlot(route.providerId, route.accountId)
    throwIfAborted(signal)
    const started = Date.now()
    routeLog('request', 'direct request', {
      provider: route.providerId,
      model: route.model,
      ...(route.accountId ? { account: route.accountId } : {}),
    })
    const isOmniRoute = route.providerId === 'omniroute'
    // Only custom routes get a retry budget; plain provider routes try once
    // and advance to the next route (a failing upstream is unlikely to heal
    // within seconds, and retrying it just delays the fallback).
    const attempts =
      route.kind === 'opencode'
        ? DIRECT_ROUTE_RETRIES
        : isOmniRoute
          ? OMNIROUTE_RETRIES
          : route.kind === 'custom'
            ? CUSTOM_ROUTE_RETRIES
            : 1
    // Keep enough loop capacity for gateway_unavailable, whose 6-attempt
    // budget is selected only after the request error is classified.
    const maxAttempts = Math.max(attempts, GATEWAY_RETRIES)
    let streamMeaningful = false
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const events: ChatCompletionChunk[] = []
        let hasToolCalls = false
        const streamText = { text: '' }
        let dsml = false
        for await (const event of await createStream(route)) {
          events.push(event)
          hasToolCalls ||= eventToolCalls(event) > 0
          dsml ||= isDsmlStart(streamText.text)
          const eventMeaningful = isMeaningfulOpenAIEvent(event)
          if (!streamMeaningful && eventMeaningful) {
            streamMeaningful = true
            setActiveCcbRoute(route.providerId, route.model)
            onFirstMeaningful?.()
          }
          throwIfUpstreamBlocked(event, streamText)
        }
        if (!streamMeaningful)
          throw new ProviderOutputError(
            `${route.providerId} returned an empty stream`,
          )
        if (
          route.providerId !== 'omniroute' &&
          !dsml &&
          isFakeSuccessBody(streamText.text)
        ) {
          throw new ProviderOutputError(
            `${route.providerId} returned a fake-success body`,
          )
        }
        if (
          isVisionRequest &&
          validateVisionResponse(streamText.text).verdict === 'reject'
        ) {
          throw new ProviderOutputError(
            `${route.providerId} returned a vision fake-success body`,
          )
        }
        if (
          route.providerId !== 'omniroute' &&
          !dsml &&
          !hasToolCalls &&
          isJunkContent(streamText.text)
        ) {
          throw new ProviderOutputError(
            `${route.providerId} returned invalid provider text`,
          )
        }
        if (route.accountId)
          clearAccountFailure(route.providerId, route.accountId)
        clearModelFailure(route.providerId, route.model)
        recordCircuitSuccess('model', route.providerId, route.model)
        if (accountKey)
          recordCircuitSuccess(
            'account',
            route.providerId,
            undefined,
            route.accountId,
          )
        routeLog('request', 'direct response complete', {
          provider: route.providerId,
          model: route.model,
          elapsedMs: Date.now() - started,
          ...(route.accountId ? { account: route.accountId } : {}),
        })
        yield* normalizeDsmlEvents(events, streamText.text)
        return
      } catch (error) {
        if (signal.aborted) throw new APIUserAbortError()
        if (streamMeaningful) throw error
        const status = (error as { status?: number } | undefined)?.status
        if (route.kind === 'opencode' && status === 404) {
          invalidateOpenCodeModelsCache()
          void refreshAutoHealth()
        }
        // OpenCode free endpoint is volatile: retry every failed attempt
        // (non-2xx, empty stream, blocked/custom error, invalid output).
        if (
          route.kind === 'opencode' &&
          status !== 404 &&
          attempt < attempts &&
          !isGatewayUnavailable(error)
        ) {
          routeLog('retry', `${route.providerId}/${route.model} retry`, {
            attempt,
            maxAttempts: attempts,
            status,
          })
          await waitForBackoff(Math.min(1000, 100 * attempt), signal)
          continue
        }
        // A `gateway_unavailable` 502 means the whole local gateway account
        // pool is down; it self-recovers once the backends restart. Give it a
        // longer bounded window than generic transient errors.
        if (isGatewayUnavailable(error) && attempt < GATEWAY_RETRIES) {
          const delayMs = retryAfterMs(error) ?? omniRouteBackoffMs(attempt)
          routeLog('retry', `${route.providerId}/${route.model} retry`, {
            attempt,
            maxAttempts: GATEWAY_RETRIES,
            delayMs,
            status,
            reason: 'gateway_unavailable',
          })
          await waitForBackoff(delayMs, signal)
          continue
        }
        // Custom routes buffer output before yielding it, so retry transient
        // failures on their bounded budget. Plain provider routes still move
        // directly to the next fallback after one failed attempt.
        const transient =
          status == null || status === 408 || status === 425 || status >= 500
        const retryLimit =
          isOmniRoute && status === 500
            ? CUSTOM_ROUTE_RETRIES
            : route.kind === 'custom'
              ? CUSTOM_ROUTE_RETRIES
              : attempts
        if (
          route.kind !== 'opencode' &&
          !isGatewayUnavailable(error) &&
          ((isOmniRoute && isOmniRouteTransientError(error)) || transient) &&
          attempt < retryLimit
        ) {
          const delayMs = isOmniRoute
            ? (retryAfterMs(error) ?? omniRouteBackoffMs(attempt))
            : 250 * 2 ** (attempt - 1)
          routeLog('retry', `${route.providerId}/${route.model} retry`, {
            attempt,
            maxAttempts: retryLimit,
            delayMs,
            status,
          })
          await waitForBackoff(delayMs, signal)
          continue
        }
        const scope = routeFailureScope(error)
        routeError(`${route.providerId}/${route.model} failed`, {
          status,
          elapsedMs: Date.now() - started,
          ...(route.accountId ? { account: route.accountId } : {}),
          errorType: error instanceof Error ? error.name : typeof error,
        })
        if (scope === 'provider') {
          skippedProviders.add(route.providerId)
          markProviderFailure(route.providerId)
          recordCircuitFailure('provider', route.providerId)
          if (status === 404) recordProviderNotAdmitted(route.providerId, 404)
          routeError(
            `${route.providerId} unavailable; skipping its remaining routes`,
            {
              status,
            },
          )
        } else if (scope === 'model') {
          skippedModels.add(modelKey)
          markModelFailure(route.providerId, route.model)
          if (status === 404)
            recordModelNotAdmitted(route.providerId, route.model, 404)
          recordCircuitFailure('model', route.providerId, route.model)
          routeError(`${modelKey} invalid; skipping its remaining accounts`, {
            status,
          })
        } else if (scope === 'account' && accountKey) {
          skippedAccounts.add(accountKey)
          markAccountFailure(route.providerId, route.accountId!)
          recordCircuitFailure(
            'account',
            route.providerId,
            undefined,
            route.accountId!,
          )
          if (status === 401 || status === 403)
            recordAccountNotAdmitted(route.providerId, route.accountId!, status)
          routeError(
            `${accountKey} unavailable; skipping its remaining routes`,
            {
              status,
            },
          )
        }
        lastError = error
        if (route.accountId)
          markAccountFailure(route.providerId, route.accountId)
        break
      }
    }
  }
  throw lastError ?? new Error('all direct providers failed')
}

export async function* retryTierDirectProviderStream(
  routes: DirectRoute[],
  timeoutMs: number,
  createStream: (
    route: DirectRoute,
    signal: AbortSignal,
  ) => Promise<AsyncIterable<ChatCompletionChunk>>,
  signal: AbortSignal,
): AsyncGenerator<ChatCompletionChunk, void> {
  let lastError: unknown
  for (const route of routes) {
    let streamMeaningful = false
    const attemptController = new AbortController()
    const abortAttempt = () => attemptController.abort()
    signal.addEventListener('abort', abortAttempt, { once: true })
    const timeout = setTimeout(abortAttempt, timeoutMs)
    try {
      yield* retryDirectProviderStream(
        [route],
        current => createStream(current, attemptController.signal),
        attemptController.signal,
        () => {
          streamMeaningful = true
          clearTimeout(timeout)
        },
      )
      return
    } catch (error) {
      if (signal.aborted) throw error
      // Never replay: once this route produced meaningful output, falling
      // through to the next route would regenerate the whole assistant turn.
      if (streamMeaningful) throw error
      lastError = error
    } finally {
      clearTimeout(timeout)
      signal.removeEventListener('abort', abortAttempt)
      abortAttempt()
    }
  }
  throw lastError ?? new Error('all direct providers failed')
}

export async function* raceDirectProviderStream(
  routes: DirectRoute[],
  createStream: (
    route: DirectRoute,
    signal: AbortSignal,
  ) => Promise<AsyncIterable<ChatCompletionChunk>>,
  signal: AbortSignal,
  onSelected?: () => void,
): AsyncGenerator<ChatCompletionChunk, void> {
  type Contender = {
    route: DirectRoute
    events: ChatCompletionChunk[]
    elapsedMs: number
    text: string
    toolCalls: number
  }
  let selected: Contender | undefined
  const raceId =
    Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
  const controllers = new Map(
    routes.map(route => [route, new AbortController()] as const),
  )
  const abort = () => controllers.forEach(controller => controller.abort())
  signal.addEventListener('abort', abort, { once: true })
  const attempts = routes.map(async (route): Promise<Contender> => {
    const started = Date.now()
    const requestSignal = controllers.get(route)!.signal
    try {
      await waitForRaceDelay(route.raceDelayMs ?? 0, requestSignal)
      const stream = await createStream(route, requestSignal)
      const events: ChatCompletionChunk[] = []
      const streamText = { text: '' }
      let toolCalls = 0
      let dsml = false
      for await (const event of stream) {
        events.push(event)
        toolCalls += eventToolCalls(event)
        throwIfUpstreamBlocked(event, streamText)
        dsml ||= isDsmlStart(streamText.text)
      }
      if (events.length === 0) {
        throw new ProviderOutputError(`${route.model} returned an empty stream`)
      }
      if (
        route.providerId !== 'omniroute' &&
        !dsml &&
        isInvalidProviderText(streamText.text)
      ) {
        throw new ProviderOutputError(
          `${route.model} returned invalid provider text`,
        )
      }
      const finalEvents = dsml
        ? normalizeDsmlEvents(events, streamText.text)
        : events
      if (
        !dsml &&
        !events.some(event => isContentfulOpenAIEvent(event)) &&
        !events.some(event => eventToolCalls(event) > 0)
      ) {
        throw new ProviderOutputError(
          `${route.model} returned no valid completion`,
        )
      }
      if (dsml && !isDsmlComplete(streamText.text)) {
        throw new ProviderOutputError(
          `${route.model} returned an incomplete tool call`,
        )
      }
      if (finalEvents.length === 0) {
        throw new ProviderOutputError(
          `${route.model} returned no valid completion`,
        )
      }
      return {
        route,
        events: finalEvents,
        elapsedMs: Date.now() - started,
        text: streamText.text,
        toolCalls,
      }
    } catch (error) {
      const status = (error as { status?: number } | undefined)?.status
      if (route.kind === 'opencode' && status === 404) {
        invalidateOpenCodeModelsCache()
        void refreshAutoHealth()
      }
      recordRaceMetric({
        at: new Date().toISOString(),
        raceId,
        provider: route.providerId,
        model: route.model,
        account: route.accountId ?? 'default',
        outcome: requestSignal.aborted ? 'cancelled' : 'failed',
        elapsedMs: Date.now() - started,
        ...(status === undefined ? {} : { status }),
        errorCategory: classifyErrorStatus(
          status,
          requestSignal.aborted,
          error instanceof Error ? error.message : String(error),
        ),
      })
      throw error
    }
  })
  try {
    routeLog(
      'race',
      `start (${routes.length})`,
      routes.map(route => `${route.accountId ?? 'default'}:${route.model}`),
    )
    // Race until a quorum of contenders returns a complete, valid result,
    // then pick the best and stop the rest immediately. If fewer than the
    // quorum ever respond, decide as soon as every attempt settles so we still
    // return the best available (or fail through to L2 when none respond).
    const quorum = Math.max(1, Math.ceil(routes.length / 2))
    const collected: Contender[] = []
    let settled = 0
    let decided = false
    let resolveDone!: () => void
    const done = new Promise<void>(resolve => (resolveDone = resolve))
    const maybeDecide = () => {
      if (decided) return
      if (collected.length >= quorum || settled >= routes.length) {
        decided = true
        resolveDone()
      }
    }
    for (const attempt of attempts) {
      attempt.then(
        contender => {
          collected.push(contender)
          settled++
          maybeDecide()
        },
        () => {
          settled++
          maybeDecide()
        },
      )
    }
    await done
    if (collected.length === 0) {
      // No contender produced a meaningful response; let the L1->L2 fallback
      // in raceThenFallbackStream take over.
      throw new ProviderOutputError('all L1 race contenders failed')
    }
    // Pick the best of the quorum: responsiveness (lower time-to-first-token)
    // dominates, with early content length and tool-call presence as tie-breakers.
    const scoreContender = (c: Contender): number =>
      -c.elapsedMs + Math.min(c.text.length, 200) + (c.toolCalls > 0 ? 50 : 0)
    const winner = collected.reduce(
      (best, c) => (scoreContender(c) > scoreContender(best) ? c : best),
      collected[0],
    )
    selected = winner
    setActiveCcbRoute(winner.route.providerId, winner.route.model)
    onSelected?.()
    controllers.forEach((controller, route) => {
      if (route !== winner.route) controller.abort()
    })
    recordRaceMetric({
      at: new Date().toISOString(),
      raceId,
      provider: winner.route.providerId,
      model: winner.route.model,
      account: winner.route.accountId ?? 'default',
      outcome: 'selected',
      elapsedMs: winner.elapsedMs,
      ttftMs: winner.elapsedMs,
      outputChars: winner.text.length,
      streamEvents: winner.events.length,
      toolCalls: winner.toolCalls,
    })
    if (winner.route.accountId)
      clearAccountFailure(winner.route.providerId, winner.route.accountId)
    clearModelFailure(winner.route.providerId, winner.route.model)
    routeLog(
      'race',
      `selected ${winner.route.model} (quorum ${collected.length}/${quorum})`,
      {
        account: winner.route.accountId,
        elapsedMs: winner.elapsedMs,
        contenders: routes.length,
      },
    )
    yield* winner.events
    recordRaceMetric({
      at: new Date().toISOString(),
      raceId,
      provider: winner.route.providerId,
      model: winner.route.model,
      account: winner.route.accountId ?? 'default',
      outcome: 'won',
      elapsedMs: winner.elapsedMs,
      ttftMs: winner.elapsedMs,
      outputChars: winner.text.length,
      streamEvents: winner.events.length,
      toolCalls: winner.toolCalls,
      responseValid: winner.text.trim().length > 0,
    })
  } finally {
    signal.removeEventListener('abort', abort)
    abort()
    void Promise.allSettled(attempts).then(results => {
      for (const result of results) {
        if (result.status !== 'fulfilled') continue
        const contender = result.value
        if (contender === selected) continue
        recordRaceMetric({
          at: new Date().toISOString(),
          raceId,
          provider: contender.route.providerId,
          model: contender.route.model,
          account: contender.route.accountId ?? 'default',
          outcome: 'cancelled',
          elapsedMs: contender.elapsedMs,
          ttftMs: contender.elapsedMs,
          outputChars: contender.text.length,
          streamEvents: contender.events.length,
          toolCalls: contender.toolCalls,
        })
      }
    })
  }
}

/**
 * Build the request body and open the Chat Completions stream for a single
 * direct route. Shared by the retry, race, and codex-fallback paths so the
 * transparent `reasoning_effort` strip lives in exactly one place.
 *
 * Several OpenAI-compatible gateways reject `reasoning_effort` (and the
 * CodeBuddy `reasoning_summary`) for models that do not support it, returning
 * a 400 such as "field ReasoningEffort invalid" or "Request extraction failed".
 * When `allowReasoningStrip` is set and the route actually sent reasoning
 * params, we retry once with those params removed instead of surfacing the 400
 * to the user. The retry can only succeed or fail the same way it would have,
 * so it never makes a genuine error worse.
 */
function isReasoningValidationError(err: unknown): boolean {
  const status = (err as { status?: number } | undefined)?.status
  return status === 400
}

async function createRouteStream(
  route: DirectRoute,
  signal: AbortSignal,
  params: {
    messages: any[]
    tools: any[]
    toolChoice: any
    enableThinking: boolean
    maxTokens: number
    temperatureOverride?: number
    fetchOverride?: typeof fetch
    source?: string
    reasoningEffort?: string
    reasoningSummary?: string
    allowReasoningStrip?: boolean
  },
): Promise<AsyncIterable<ChatCompletionChunk>> {
  const buildBody = (strip: boolean): ChatCompletionCreateParamsStreaming => {
    const body = buildOpenAIRequestBody({
      model: route.model,
      messages: params.messages,
      tools: params.tools,
      toolChoice: params.toolChoice,
      enableThinking: params.enableThinking,
      maxTokens: params.maxTokens,
      reasoningEffort: strip
        ? undefined
        : clampReasoningEffort(route.providerId, params.reasoningEffort),
      reasoningSummary: strip
        ? undefined
        : (params.reasoningSummary ??
          (route.providerId === 'codebuddy-cn' ? 'auto' : undefined)),
      temperatureOverride: params.temperatureOverride,
    })
    const compatibleBody = route.compatRule
      ? applyCompatRule(
          body as unknown as Record<string, unknown>,
          route.compatRule,
        )
      : body
    const sanitizedBody =
      route.providerId === 'codebuddy-cn'
        ? sanitizeCodeBuddyRequestBody(
            compatibleBody as unknown as Record<string, unknown>,
          )
        : compatibleBody
    const requestBody =
      route.providerId === 'nvidia'
        ? sanitizeNvidiaRequestBody(
            sanitizedBody as unknown as Record<string, unknown>,
          )
        : sanitizedBody
    return requestBody as ChatCompletionCreateParamsStreaming
  }
  // ── Kiro: native AWS EventStream protocol (not OpenAI-compatible) ──
  // kiro.dev accepts an OpenAI-shaped body + Bearer token and streams back an
  // AWS EventStream we translate into OpenAI chunks. Bypass the OpenAI client.
  if (route.providerId === 'kiro') {
    return Promise.resolve(
      createKiroStream({
        baseURL: route.baseURL,
        apiKey: route.apiKey,
        model: route.model,
        body: buildBody(false),
        headers: route.headers,
        timeoutMs: route.timeoutMs,
        signal,
        fetchImpl: params.fetchOverride,
      }),
    )
  }
  // ── GitHub Copilot: exchange the GitHub access token for a Copilot token ──
  let resolvedApiKey = route.apiKey
  if (route.providerId === 'github') {
    try {
      resolvedApiKey = await getCopilotToken({
        accessToken: route.apiKey,
        headers: route.headers,
        fetchImpl: params.fetchOverride,
      })
    } catch (err) {
      invalidateCopilotToken(route.apiKey)
      throw err
    }
  }
  const doCreate = (strip: boolean) => {
    if (route.routeId) {
      beginCcbRoute(route.routeId, route.model, route.receiptPolicy ?? 'none')
    }
    return getOpenAIClient({
      maxRetries: 0,
      baseURL: route.baseURL,
      apiKey: resolvedApiKey,
      defaultHeaders: route.headers,
      timeoutMs: route.timeoutMs,
      providerId: route.providerId,
      accountId: route.accountId,
      receiptPolicy: route.receiptPolicy,
      fetchOverride: params.fetchOverride,
      source: params.source,
    }).chat.completions.create(buildBody(strip), { signal })
  }
  if (!params.allowReasoningStrip) return doCreate(false)
  const sentReasoning = Boolean(
    params.reasoningEffort || params.reasoningSummary,
  )
  if (!sentReasoning) return doCreate(false)
  try {
    return await doCreate(false)
  } catch (err) {
    if (isReasoningValidationError(err)) {
      routeLog(
        'reasoning',
        `stripping reasoning params for ${route.providerId}/${route.model} after 400`,
      )
      return await doCreate(true)
    }
    throw err
  }
}

async function* allOfRaceStream(
  routes: DirectRoute[],
  createStream: (
    route: DirectRoute,
    signal: AbortSignal,
  ) => Promise<AsyncIterable<ChatCompletionChunk>>,
  signal: AbortSignal,
  onSelected?: () => void,
): AsyncGenerator<ChatCompletionChunk, void> {
  const mode = raceAllOfMode()
  if (!mode || routes.length < 2) {
    yield* raceDirectProviderStream(routes, createStream, signal, onSelected)
    return
  }
  const started = Date.now()
  const controllers = new Map(
    routes.map(route => [route, new AbortController()] as const),
  )
  const abort = () => controllers.forEach(c => c.abort())
  signal.addEventListener('abort', abort, { once: true })
  type Completed = {
    route: DirectRoute
    fullText: string
    toolCalls: number
  }
  const attempts = routes.map(async (route): Promise<Completed> => {
    const requestSignal = controllers.get(route)!.signal
    const stream = await createStream(route, requestSignal)
    const iterator = stream[Symbol.asyncIterator]()
    let fullText = ''
    let toolCalls = 0
    for (;;) {
      const next = await iterator.next()
      if (next.done) break
      fullText += eventText(next.value)
      toolCalls += eventToolCalls(next.value)
      if (signal.aborted) {
        throw new APIUserAbortError()
      }
    }
    return { route, fullText, toolCalls }
  })
  try {
    const results = await Promise.allSettled(attempts)
    const completed = results
      .filter(
        (r): r is PromiseFulfilledResult<Completed> => r.status === 'fulfilled',
      )
      .map(r => r.value)
      .filter(c => c.fullText.trim().length > 0 && !isJunkContent(c.fullText))
    if (completed.length < 2) {
      if (completed.length === 1) {
        const stream = await createStream(completed[0].route, signal)
        let streamMeaningful = false
        for await (const event of stream) {
          if (!streamMeaningful && isMeaningfulOpenAIEvent(event)) {
            streamMeaningful = true
            onSelected?.()
          }
          yield event
        }
        return
      }
      throw new ProviderOutputError('allOf: no quorum completed')
    }
    const answers: PanelAnswer[] = completed.map(c => ({
      model: c.route.model,
      text: c.fullText,
    }))
    const fused = fuseAnswers(answers, mode)
    if (!fused || !hasMeaningfulContent(fused))
      throw new ProviderOutputError('allOf: fusion returned low-quality output')
    onSelected?.()
    routeLog('race', `allOf fused ${completed.length} responses -> ${mode}`, {
      models: completed.map(c => c.route.model).join(', '),
    })
    recordRaceMetric({
      at: new Date().toISOString(),
      provider: answers[0].model.split('/')[0] || 'fused',
      model: answers[0].model,
      account: 'allOf',
      outcome: 'selected',
      elapsedMs: Date.now() - started,
      responseValid: !isJunkContent(fused),
    })
    const baseChunk = {
      id: `allOf-${Date.now()}`,
      model: 'fused-allOf',
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      choices: [{ index: 0, delta: { content: fused }, finish_reason: 'stop' }],
    } as ChatCompletionChunk
    yield baseChunk
  } finally {
    signal.removeEventListener('abort', abort)
    abort()
  }
}

export async function* raceThenFallbackStream(
  tierGroups: DirectRoute[][],
  createStream: (
    route: DirectRoute,
    signal: AbortSignal,
  ) => Promise<AsyncIterable<ChatCompletionChunk>>,
  signal: AbortSignal,
  isVisionRequest = false,
): AsyncGenerator<ChatCompletionChunk, void> {
  const [l1Group, ...fallbackGroups] = tierGroups
  const l1Controller = new AbortController()
  const abortL1 = () => l1Controller.abort()
  signal.addEventListener('abort', abortL1, { once: true })
  let l1TimedOut = false
  let streamMeaningful = false
  const timeout = setTimeout(() => {
    l1TimedOut = true
    abortL1()
  }, AUTO_L1_RACE_TIMEOUT_MS)
  const markStreamMeaningful = () => {
    streamMeaningful = true
    clearTimeout(timeout)
  }
  const raceRoutes = (l1Group ?? []).filter(
    route => route.race || route.kind === 'race',
  )
  const downgradeRoutes = (l1Group ?? []).filter(
    route => !route.race && route.kind !== 'race',
  )
  try {
    if (raceRoutes.length)
      yield* allOfRaceStream(
        raceRoutes,
        createStream,
        l1Controller.signal,
        markStreamMeaningful,
      )
    else if (downgradeRoutes.length)
      yield* retryDirectProviderStream(
        downgradeRoutes,
        route => createStream(route, l1Controller.signal),
        l1Controller.signal,
        markStreamMeaningful,
        isVisionRequest,
      )
  } catch (error) {
    if (signal.aborted || streamMeaningful) throw error
    if (l1TimedOut)
      routeError('auto L1 race budget exhausted; entering fallback tiers', {
        l1: (l1Group ?? []).length,
        fallback: fallbackGroups.reduce((n, g) => n + g.length, 0),
        timeoutMs: AUTO_L1_RACE_TIMEOUT_MS,
      })
    // Surface the error from the route whose retry budget was most recently
    // exhausted, not the stale L1 failure captured at the start of escalation.
    let lastError = error
    if (!l1Controller.signal.aborted && downgradeRoutes.length) {
      try {
        yield* retryDirectProviderStream(
          downgradeRoutes,
          route => createStream(route, l1Controller.signal),
          l1Controller.signal,
          markStreamMeaningful,
          isVisionRequest,
        )
        return
      } catch (downgradeError) {
        if (signal.aborted || streamMeaningful) throw downgradeError
        lastError = downgradeError
      }
    }
    // Escalate through L2..L6 (and any further tiers) in order.
    let level = 2
    for (const group of fallbackGroups) {
      if (!group.length) {
        level++
        continue
      }
      const timeoutMs = autoTierTtfsTimeoutMs(level)
      if (!l1TimedOut)
        routeError(`auto L${level - 1} exhausted; entering L${level} pool`, {
          l1: (l1Group ?? []).length,
          [`l${level}`]: group.length,
          timeoutMs,
        })
      try {
        yield* retryDirectProviderStream(
          group,
          route => createStream(route, signal),
          signal,
          markStreamMeaningful,
          isVisionRequest,
        )
        return
      } catch (tierError) {
        if (signal.aborted || streamMeaningful) throw tierError
        lastError = tierError
        level++
      }
    }
    throw lastError
  } finally {
    clearTimeout(timeout)
    signal.removeEventListener('abort', abortL1)
    abortL1()
  }
}

function isOpenAIConvertibleMessage(
  msg: Message,
): msg is AssistantMessage | UserMessage {
  return msg.type === 'assistant' || msg.type === 'user'
}

/**
 * Assemble the final AssistantMessage (and optional max_tokens error) from
 * accumulated stream state. Extracted to avoid duplication between the
 * `message_stop` handler and the post-loop safety fallback.
 */
function assembleFinalAssistantOutputs(params: {
  partialMessage: BetaMessage | null
  contentBlocks: Record<number, Record<string, unknown>>
  tools: Tools
  agentId: string | undefined
  usage: {
    input_tokens: number
    output_tokens: number
    cache_creation_input_tokens: number
    cache_read_input_tokens: number
  }
  stopReason: string | null
  maxTokens: number
}): (AssistantMessage | SystemAPIErrorMessage)[] {
  const {
    partialMessage,
    contentBlocks,
    tools,
    agentId,
    usage,
    stopReason,
    maxTokens,
  } = params
  const outputs: (AssistantMessage | SystemAPIErrorMessage)[] = []

  const allBlocks = Object.keys(contentBlocks)
    .sort((a, b) => Number(a) - Number(b))
    .map(k => contentBlocks[Number(k)])
    .filter(Boolean)

  if (allBlocks.length > 0 && partialMessage) {
    outputs.push({
      message: {
        ...partialMessage,
        content: normalizeContentFromAPI(
          allBlocks as unknown as BetaMessage['content'],
          tools,
          agentId as AgentId | undefined,
        ),
        usage,
        stop_reason: stopReason,
        stop_sequence: null,
      } as AssistantMessage['message'],
      requestId: undefined,
      type: 'assistant',
      uuid: randomUUID(),
      timestamp: new Date().toISOString(),
    } as AssistantMessage)
  }

  if (stopReason === 'max_tokens') {
    outputs.push(
      createAssistantAPIErrorMessage({
        content:
          `Output truncated: response exceeded the ${maxTokens} token limit. ` +
          `Set OPENAI_MAX_TOKENS or CLAUDE_CODE_MAX_OUTPUT_TOKENS to override.`,
        apiError: 'max_output_tokens',
        error: 'max_output_tokens',
      }),
    )
  }

  return outputs
}

/**
 * OpenAI-compatible query path. Converts Anthropic-format messages/tools to
 * OpenAI format, calls the OpenAI-compatible endpoint, and converts the
 * SSE stream back to Anthropic BetaRawMessageStreamEvent for consumption
 * by the existing query pipeline.
 */
export async function* queryModelOpenAI(
  messages: Message[],
  systemPrompt: SystemPrompt,
  tools: Tools,
  signal: AbortSignal,
  options: Options,
): AsyncGenerator<
  StreamEvent | AssistantMessage | SystemAPIErrorMessage,
  void
> {
  try {
    const latestUserPrompt = [...messages]
      .reverse()
      .find(message => message.type === 'user')
    const promptContent = latestUserPrompt?.message?.content
    const advisorPrompt =
      typeof promptContent === 'string'
        ? promptContent
        : Array.isArray(promptContent)
          ? promptContent
              .filter(
                block => block && typeof block === 'object' && 'text' in block,
              )
              .map(block => String((block as { text?: unknown }).text ?? ''))
              .join('\n')
          : undefined
    const explicitRoutes = resolveDirectRoutes(options.model, advisorPrompt)
    const isLocalCodexAdvisor =
      isChatGPTAuthMode() &&
      /^(?:ccb\/)?(?:advisor|lite|full|ultra|review|smart|opus)$/i.test(
        options.model.trim(),
      )
    const advisorFallbackRoutes = explicitRoutes.filter(
      route => route.providerId !== LOCAL_CODEX_ADVISOR,
    )
    const originalDirectRoutes: DirectRoute[] =
      advisorFallbackRoutes.length > 0
        ? advisorFallbackRoutes
        : getAPIProvider() === 'opencode-free'
          ? [
              {
                providerId: 'opencode',
                baseURL: OPENCODE_FREE_BASE_URL,
                model:
                  currentFreeOpenCodeModels()[0] ??
                  getOpencodeModelName(options.model),
                apiKey: 'public',
                headers: {
                  'x-opencode-client': 'desktop',
                  Accept: 'text/event-stream',
                },
                kind: 'opencode',
              },
            ]
          : []
    // Policy snapshot: the resolved routes as-is (virtual-model, Codex advisor,
    // server-side routing decisions). The race pool below must not leak into
    // these reads — dispatch uses effectiveDirectRoutes instead.
    const originalDirectRoute: DirectRoute | undefined = originalDirectRoutes[0]
    const localFallbackConfig =
      originalDirectRoutes.length === 1 &&
      originalDirectRoute?.providerId === 'omniroute'
        ? getLocalFallbackConfig()
        : null
    const localFallbackRoute: DirectRoute | undefined = localFallbackConfig
      ? {
          providerId: 'ccb-local-fallback',
          baseURL: localFallbackConfig.baseUrl,
          model: localFallbackConfig.model,
          apiKey: localFallbackConfig.apiKey,
          kind: 'provider',
        }
      : undefined
    const isOmniRouteServerRouting =
      originalDirectRoute?.providerId === 'omniroute' &&
      getOmniRouteConfig()?.serverSideRouting === true
    const useGatewayPrimary =
      isOmniRouteServerRouting &&
      process.env.CCB_GATEWAY_PRIMARY !== '0' &&
      process.env.CCB_ROUTE_TIER_ORDER !== '1'

    // Server-side routing owns scoring and races while the gateway is primary.
    // Retain the direct tier pool only for an explicitly requested legacy path.
    const effectiveDirectRoutes = useGatewayPrimary
      ? originalDirectRoutes
      : buildDirectRacePool(originalDirectRoutes)
    const gatewayFallbackRoutes = useGatewayPrimary
      ? buildDirectRacePool(originalDirectRoutes)
          .filter(route => route.providerId !== 'omniroute')
          .slice(0, 2)
      : []
    if (localFallbackRoute) gatewayFallbackRoutes.push(localFallbackRoute)

    // Provider-prefixed models use CCB's direct transport; ChatGPT Responses
    // must not receive those ids.
    const isOpencodeRoute =
      isOpencodeModel(options.model) ||
      getAPIProvider() === 'opencode-free' ||
      (originalDirectRoute !== undefined && !isLocalCodexAdvisor)

    // 1. Resolve model name. Provider ids pass through direct routing; opencode/*
    //    ids get the prefix stripped for re-prefixing below; ccb/* ids get
    //    the `ccb/` prefix stripped and resolve via OPENAI_BASE_URL.
    // `advisor` is CCB's virtual model. With a local ChatGPT account pool it
    // deliberately resolves to Codex Responses instead of the provider-registry
    // advisor combo, so no OmniRoute/gateway is part of this path.
    const openaiModel = isLocalCodexAdvisor
      ? CHATGPT_CODEX_DEFAULT_MODEL
      : originalDirectRoute
        ? originalDirectRoute.model
        : isOpencodeRoute
          ? getOpencodeModelName(options.model)
          : isCCBRoutingModel(options.model)
            ? options.model.slice('ccb/'.length)
            : resolveOpenAIModel(options.model)

    // 2. Normalize messages using shared preprocessing
    const messagesForAPI = normalizeMessagesForAPI(messages, tools)

    // 3. Check if tool search is enabled (similar to Anthropic path)
    const useSearchExtraTools = await isSearchExtraToolsEnabled(
      options.model,
      tools,
      options.getToolPermissionContext ||
        (async () => getEmptyToolPermissionContext()),
      options.agents || [],
      options.querySource,
    )

    // 4. Build deferred tools set (similar to Anthropic path)
    const deferredToolNames = new Set<string>()
    if (useSearchExtraTools) {
      for (const t of tools) {
        if (isDeferredTool(t)) deferredToolNames.add(t.name)
      }
    }

    // 5. Filter tools (similar to Anthropic path)
    // Never include deferred tools in the API tools array — they are invoked
    // via ExecuteExtraTool which looks them up from the global tool registry
    // at runtime. Keeping the tools array stable preserves the prompt cache.
    let filteredTools = tools
    if (useSearchExtraTools && deferredToolNames.size > 0) {
      filteredTools = tools.filter(tool => {
        // Always include non-deferred tools
        if (!deferredToolNames.has(tool.name)) return true
        // Always include SearchExtraToolsTool (so it can discover more tools)
        if (toolMatchesName(tool, SEARCH_EXTRA_TOOLS_TOOL_NAME)) return true
        // All other deferred tools are excluded — use ExecuteExtraTool instead
        return false
      })
    }

    // 6. Build tool schemas with deferLoading flag
    const toolSchemas = await Promise.all(
      filteredTools.map(tool =>
        toolToAPISchema(tool, {
          getToolPermissionContext: options.getToolPermissionContext,
          tools,
          agents: options.agents,
          allowedAgentTypes: options.allowedAgentTypes,
          model: options.model,
          deferLoading: useSearchExtraTools && deferredToolNames.has(tool.name),
        }),
      ),
    )

    // 7. Filter out non-standard tools (server tools like advisor)
    const standardTools = toolSchemas.filter(
      (t): t is BetaToolUnion & { type: string } => {
        const anyT = t as unknown as Record<string, unknown>
        return (
          anyT.type !== 'advisor_20260301' && anyT.type !== 'computer_20250124'
        )
      },
    )

    // 8. Convert messages and tools to OpenAI format
    const enableThinking = isOpenAIThinkingEnabled(openaiModel)
    const openAIConvertibleMessages = messagesForAPI.filter(
      isOpenAIConvertibleMessage,
    )
    const messagesWithDeferredToolList = prependDeferredToolListIfNeeded(
      openAIConvertibleMessages,
      tools,
      deferredToolNames,
      useSearchExtraTools,
    )
    const openaiMessages = anthropicMessagesToOpenAI(
      messagesWithDeferredToolList,
      systemPrompt,
      { enableThinking },
    )
    // Vision requests need their stream text passed through the vision
    // semantic gate: some gateways return an image/data URL instead of an
    // explanation, and that must be treated as a failed route, not success.
    const isVisionRequest = openaiMessages.some(message =>
      containsVisionInput(message),
    )
    const openaiTools = anthropicToolsToOpenAI(standardTools)
    const openaiToolChoice = anthropicToolChoiceToOpenAI(options.toolChoice)
    const reasoningEffort = isOmniRouteServerRouting
      ? undefined
      : getChatGPTResponsesReasoningEffort(options.effortValue)
    // Direct routes need their concrete effort value. Provider-specific
    // sanitizers below reduce unsupported levels before sending.
    const appliedEffort =
      !isOmniRouteServerRouting &&
      (isOpencodeRoute || effectiveDirectRoutes.length > 0)
        ? resolveAppliedEffort(options.model, options.effortValue)
        : undefined
    const reasoningEffortParam =
      typeof appliedEffort === 'string' ? appliedEffort : undefined

    // 9. Log tool filtering details
    if (useSearchExtraTools) {
      const includedDeferredTools = filteredTools.filter(t =>
        deferredToolNames.has(t.name),
      ).length
      logForDebugging(
        `[OpenAI] Tool search enabled: ${includedDeferredTools}/${deferredToolNames.size} deferred tools included, total tools=${openaiTools.length}`,
      )
    } else {
      logForDebugging(
        `[OpenAI] Tool search disabled, total tools=${openaiTools.length}`,
      )
    }

    // 10. Compute max_tokens — required by most OpenAI-compatible endpoints.
    //     Without this the server uses a tiny default, and when
    //     thinking is enabled the thinking phase consumes the entire budget
    //     leaving no tokens for the final response.
    //
    //     Use upperLimit (not the slot-cap default) because the Anthropic path's
    //     slot-reservation cap (CAPPED_DEFAULT_MAX_TOKENS=8k) is paired with an
    //     auto-retry at 64k in query.ts. The OpenAI path has no such retry, so
    //     using the capped 8k default would silently truncate responses in
    //     multi-turn conversations where thinking consumes most of the budget.
    //
    //     Override priority:
    //     1. options.maxOutputTokensOverride (programmatic)
    //     2. OPENAI_MAX_TOKENS env var (OpenAI-specific, useful for local models
    //        with small context windows, e.g. RTX 3060 12GB running 65536-token models)
    //     3. CLAUDE_CODE_MAX_OUTPUT_TOKENS env var (generic override)
    //     4. upperLimit default (64000)
    const { upperLimit } = getModelMaxOutputTokens(openaiModel)
    const maxTokens = resolveOpenAIMaxTokens(
      upperLimit,
      options.maxOutputTokensOverride,
    )

    const isOpencodeFree = isOpencodeRoute
    // Only route to the ChatGPT Responses (Codex) backend when the resolved
    // model is actually a supported ChatGPT model. Otherwise fall back to the
    // OpenAI-compatible path so provider-selected models (e.g. qwen3.5-plus,
    // deepseek via ccb) do not get rejected by ChatGPT's whitelist.
    const useChatGPTResponses =
      !isOpencodeFree &&
      isChatGPTAuthEnabled() &&
      isChatGPTCodexReasoningModel(openaiModel)
    // opencode/* ids gain the provider prefix expected by the direct endpoint.
    const requestModel = isLocalCodexAdvisor
      ? openaiModel
      : originalDirectRoute
        ? originalDirectRoute.model
        : isOpencodeModel(options.model)
          ? `opencode/${openaiModel}`
          : isCCBModel(options.model)
            ? options.model.slice('ccb/'.length)
            : isCCBRoutingModel(options.model)
              ? openaiModel
              : openaiModel
    // OpenAI's official OAuth and API-key routes share the same prompt-cache
    // contract. Scope the key to the real conversation so resumed turns stay
    // sticky while unrelated sessions do not share a routing bucket. Generic
    // compatible endpoints intentionally receive no OpenAI-specific fields.
    const sessionId = getSessionId()
    const sessionPromptCacheKey = formatOpenAIPromptCacheKey(sessionId)
    const promptCacheKey = useChatGPTResponses
      ? sessionPromptCacheKey
      : getOfficialOpenAIPromptCacheKey(process.env.OPENAI_BASE_URL, sessionId)
    const useOfficialOpenAICache = promptCacheKey !== undefined

    logForDebugging(
      `[OpenAI] Calling model=${openaiModel}, messages=${openaiMessages.length}, tools=${openaiTools.length}, thinking=${enableThinking}${promptCacheKey ? `, prompt_cache_key=${promptCacheKey}` : ''}`,
    )

    // 11. Call OpenAI API with streaming. ChatGPT subscription auth uses the
    // Codex Responses backend; API-key/OpenAI-compatible auth keeps the
    // existing Chat Completions adapter.
    const createDirectRequest = () => {
      const body = buildOpenAIRequestBody({
        model: requestModel,
        messages: openaiMessages,
        tools: openaiTools,
        toolChoice: openaiToolChoice,
        enableThinking,
        maxTokens,
        reasoningEffort: clampReasoningEffort(
          originalDirectRoute?.providerId ??
            (isOpencodeRoute ? 'opencode' : undefined),
          reasoningEffortParam,
        ),
        reasoningSummary:
          originalDirectRoute?.providerId === 'codebuddy-cn'
            ? 'auto'
            : undefined,
        temperatureOverride: options.temperatureOverride,
      })
      const compatibleBody = originalDirectRoute?.compatRule
        ? applyCompatRule(
            body as unknown as Record<string, unknown>,
            originalDirectRoute.compatRule,
          )
        : body
      const sanitizedBody =
        originalDirectRoute?.providerId === 'codebuddy-cn'
          ? sanitizeCodeBuddyRequestBody(
              compatibleBody as unknown as Record<string, unknown>,
            )
          : compatibleBody
      const requestBody =
        originalDirectRoute?.providerId === 'nvidia'
          ? sanitizeNvidiaRequestBody(
              sanitizedBody as unknown as Record<string, unknown>,
            )
          : sanitizedBody
      if (originalDirectRoute?.routeId) {
        beginCcbRoute(
          originalDirectRoute.routeId,
          originalDirectRoute.model,
          originalDirectRoute.receiptPolicy ?? 'none',
        )
      }
      return getOpenAIClient({
        maxRetries: 0,
        baseURL: originalDirectRoute?.baseURL ?? OPENCODE_FREE_BASE_URL,
        apiKey: originalDirectRoute?.apiKey ?? 'opencode-free-local',
        defaultHeaders: originalDirectRoute?.headers,
        timeoutMs: originalDirectRoute?.timeoutMs,
        providerId: originalDirectRoute?.providerId,
        accountId: originalDirectRoute?.accountId,
        receiptPolicy: originalDirectRoute?.receiptPolicy,
        fetchOverride: options.fetchOverride as unknown as typeof fetch,
        source: options.querySource,
      }).chat.completions.create(
        requestBody as ChatCompletionCreateParamsStreaming,
        { signal },
      )
    }

    const runDirectFallback = (
      routes: DirectRoute[],
      isVisionRequest = false,
    ): AsyncIterable<ChatCompletionChunk> =>
      retryDirectProviderStream(
        routes,
        route =>
          createRouteStream(route, signal, {
            messages: openaiMessages,
            tools: openaiTools,
            toolChoice: openaiToolChoice,
            enableThinking,
            maxTokens: Math.min(maxTokens, ADVISOR_AUTO_MAX_TOKENS),
            reasoningEffort: isLocalCodexAdvisor
              ? undefined
              : reasoningEffortParam,
            temperatureOverride: options.temperatureOverride,
            fetchOverride: options.fetchOverride as unknown as typeof fetch,
            source: options.querySource,
            allowReasoningStrip: true,
          }),
        signal,
        undefined,
        isVisionRequest,
      )

    // When the ChatGPT Codex account pool is exhausted or unavailable, fall
    // back to the OpenAI-compatible auto routes (e.g. opencode deepseek-free)
    // so a dead subscription cannot halt the whole session. The virtual
    // `advisor` model already wires this (see resolveDirectRoutes); extend it
    // to every Codex reasoning model so a plain `gpt-5.6-terra` chat — such as
    // the WeChat channel — recovers the same way instead of erroring out.
    let codexFallbackCache: DirectRoute[] | undefined
    const codexFallbackRoutes = (): DirectRoute[] => {
      if (codexFallbackCache) return codexFallbackCache
      codexFallbackCache =
        effectiveDirectRoutes.length > 0
          ? effectiveDirectRoutes
          : useChatGPTResponses
            ? resolveDirectRoutes('auto', advisorPrompt)
            : []
      return codexFallbackCache
    }
    const useCodexFallback =
      useChatGPTResponses || effectiveDirectRoutes.length > 0

    const runOmniRouteWithLocalFallback =
      async function* (): AsyncGenerator<ChatCompletionChunk> {
        try {
          yield* retryDirectProviderStream(
            effectiveDirectRoutes,
            route =>
              createRouteStream(route, signal, {
                messages: openaiMessages,
                tools: openaiTools,
                toolChoice: openaiToolChoice,
                enableThinking,
                maxTokens,
                reasoningEffort: reasoningEffortParam,
                temperatureOverride: options.temperatureOverride,
                fetchOverride: options.fetchOverride as unknown as typeof fetch,
                source: options.querySource,
                allowReasoningStrip: true,
              }),
            signal,
            undefined,
            isVisionRequest,
          )
        } catch (error) {
          if (!localFallbackRoute || !isLocalFallbackEligible(error))
            throw error
          yield* retryDirectProviderStream(
            [localFallbackRoute],
            route =>
              createRouteStream(route, signal, {
                messages: openaiMessages,
                tools: openaiTools,
                toolChoice: openaiToolChoice,
                enableThinking,
                maxTokens,
                reasoningEffort: reasoningEffortParam,
                temperatureOverride: options.temperatureOverride,
                fetchOverride: options.fetchOverride as unknown as typeof fetch,
                source: options.querySource,
                allowReasoningStrip: true,
              }),
            signal,
            undefined,
            isVisionRequest,
          )
        }
      }

    const rawStream:
      | AsyncIterable<ChatCompletionChunk>
      | AsyncIterable<Record<string, unknown>> = useChatGPTResponses
      ? await (async () => {
          return createChatGPTResponsesStream({
            request: buildResponsesRequest({
              model: requestModel,
              messages: openaiMessages,
              tools: openaiTools,
              toolChoice: openaiToolChoice,
              reasoningEffort,
              promptCacheKey: sessionPromptCacheKey,
            }),
            signal,
            fetchOverride: options.fetchOverride as unknown as typeof fetch,
            ...(useCodexFallback
              ? {
                  onAccountExhausted: () =>
                    chatCompletionsToResponses(
                      runDirectFallback(codexFallbackRoutes(), isVisionRequest),
                    ),
                  onAccountUnavailable: () =>
                    chatCompletionsToResponses(
                      runDirectFallback(codexFallbackRoutes(), isVisionRequest),
                    ),
                }
              : {}),
          })
        })()
      : await (effectiveDirectRoutes.some(
          route => route.kind === 'race' || route.race,
        )
          ? raceThenFallbackStream(
              (() => {
                const tierOrder = ['l1', 'l2', 'l3', 'l4', 'l5', 'l6'] as const
                const byTier = new Map<string, DirectRoute[]>()
                for (const t of tierOrder) byTier.set(t, [])
                for (const r of effectiveDirectRoutes) {
                  const t = r.tier && tierOrder.includes(r.tier) ? r.tier : 'l1'
                  byTier.get(t)!.push(r)
                }
                return tierOrder
                  .map(t => byTier.get(t)!)
                  .filter(g => g.length > 0)
              })(),
              (route, raceSignal) =>
                createRouteStream(route, raceSignal, {
                  messages: openaiMessages,
                  tools: openaiTools,
                  toolChoice: openaiToolChoice,
                  enableThinking,
                  maxTokens,
                  reasoningEffort: reasoningEffortParam,
                  temperatureOverride: options.temperatureOverride,
                  fetchOverride:
                    options.fetchOverride as unknown as typeof fetch,
                  source: options.querySource,
                  allowReasoningStrip: true,
                }),
              signal,
              isVisionRequest,
            )
          : effectiveDirectRoutes.length > 0
            ? originalDirectRoute?.providerId === 'omniroute' &&
              localFallbackRoute &&
              effectiveDirectRoutes.length === 1
              ? runOmniRouteWithLocalFallback()
              : retryDirectProviderStream(
                  effectiveDirectRoutes,
                  route =>
                    createRouteStream(route, signal, {
                      messages: openaiMessages,
                      tools: openaiTools,
                      toolChoice: openaiToolChoice,
                      enableThinking,
                      maxTokens,
                      reasoningEffort: reasoningEffortParam,
                      temperatureOverride: options.temperatureOverride,
                      fetchOverride:
                        options.fetchOverride as unknown as typeof fetch,
                      source: options.querySource,
                      allowReasoningStrip: true,
                    }),
                  signal,
                  undefined,
                  isVisionRequest,
                )
            : isOpencodeFree
              ? retryOpencodeFreeStream(() => createDirectRequest(), signal)
              : getOpenAIClient({
                  maxRetries: 0,
                  fetchOverride:
                    options.fetchOverride as unknown as typeof fetch,
                  source: options.querySource,
                }).chat.completions.create(
                  buildOpenAIRequestBody({
                    model: openaiModel,
                    messages: openaiMessages,
                    tools: openaiTools,
                    toolChoice: openaiToolChoice,
                    enableThinking,
                    maxTokens,
                    reasoningEffort: clampReasoningEffort(
                      undefined,
                      reasoningEffortParam,
                    ),
                    temperatureOverride: options.temperatureOverride,
                    promptCacheKey,
                  }),
                  { signal },
                ))

    const adaptedStream = useChatGPTResponses
      ? adaptResponsesStreamToAnthropic(
          rawStream as AsyncIterable<Record<string, unknown>>,
          requestModel,
        )
      : adaptOpenAIStreamToAnthropic(
          rawStream as AsyncIterable<ChatCompletionChunk>,
          requestModel,
          { includeCacheWriteTokens: useOfficialOpenAICache },
        )

    // 12. Convert OpenAI stream to Anthropic events, then process into
    //     AssistantMessage + StreamEvent (matching the Anthropic path behavior)

    // Accumulate content blocks and usage, same as the Anthropic path in claude.ts
    const contentBlocks: Record<number, Record<string, unknown>> = {}
    const collectedMessages: AssistantMessage[] = []
    let partialMessage: BetaMessage | null = null
    let stopReason: string | null = null
    let usage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    }
    let ttftMs = 0
    const start = Date.now()

    for await (const event of adaptedStream) {
      switch (event.type) {
        case 'message_start': {
          partialMessage = event.message
          ttftMs = Date.now() - start
          if (event.message.usage) {
            usage = {
              ...usage,
              ...(event.message.usage as unknown as typeof usage),
            }
          }
          break
        }
        case 'content_block_start': {
          const idx = event.index
          const cb = event.content_block
          if (cb.type === 'tool_use') {
            contentBlocks[idx] = { ...cb, input: '' }
          } else if (cb.type === 'text') {
            contentBlocks[idx] = { ...cb, text: '' }
          } else if (cb.type === 'thinking') {
            contentBlocks[idx] = { ...cb, thinking: '', signature: '' }
          } else {
            contentBlocks[idx] = { ...cb }
          }
          break
        }
        case 'content_block_delta': {
          const idx = event.index
          const delta = event.delta
          const block = contentBlocks[idx]
          if (!block) break
          if (delta.type === 'text_delta') {
            block.text = ((block.text as string | undefined) || '') + delta.text
            // Backstop for non-direct paths (plain OpenAI SDK stream): a 200
            // stream whose text matches an upstream custom-error pattern must
            // fail the turn instead of being displayed as a model reply.
            const blocked = matchUpstreamCustomError(
              block.text as string | undefined,
            )
            if (blocked) throw new UpstreamBlockedError(blocked)
          } else if (delta.type === 'input_json_delta') {
            block.input =
              ((block.input as string | undefined) || '') + delta.partial_json
          } else if (delta.type === 'thinking_delta') {
            block.thinking =
              ((block.thinking as string | undefined) || '') + delta.thinking
          } else if (delta.type === 'signature_delta') {
            block.signature = delta.signature
          }
          break
        }
        case 'content_block_stop': {
          // Block accumulation is complete; assembly happens at message_stop.
          break
        }
        case 'message_delta': {
          const deltaUsage = event.usage
          if (deltaUsage) {
            usage = updateOpenAIUsage(
              usage,
              deltaUsage as unknown as Parameters<typeof updateOpenAIUsage>[1],
            )
          }
          if (event.delta.stop_reason != null) {
            stopReason = event.delta.stop_reason
          }
          break
        }
        case 'message_stop': {
          // Assemble ONE AssistantMessage with ALL content blocks, matching the
          // Anthropic SDK path. Real usage (input + output tokens) is available
          // here and injected so tokenCountWithEstimation() can read it.
          if (partialMessage) {
            for (const output of assembleFinalAssistantOutputs({
              partialMessage,
              contentBlocks,
              tools,
              agentId: options.agentId,
              usage,
              stopReason,
              maxTokens,
            })) {
              if (output.type === 'assistant') {
                collectedMessages.push(output)
              }
              yield output
            }
            // Reset partialMessage so the post-loop safety fallback does not
            // yield a second identical AssistantMessage.
            partialMessage = null
          }
          // Track cost and token usage
          if (usage.input_tokens + usage.output_tokens > 0) {
            const costUSD = calculateUSDCost(
              openaiModel,
              usage as unknown as BetaUsage,
            )
            addToTotalSessionCost(
              costUSD,
              usage as unknown as BetaUsage,
              options.model,
            )
          }
          break
        }
      }

      // Also yield as StreamEvent for real-time display (matching Anthropic path)
      yield {
        type: 'stream_event',
        event,
        ...(event.type === 'message_start' ? { ttftMs } : undefined),
      } as StreamEvent
    }

    // Record LLM observation in Langfuse (no-op if not configured)
    recordLLMObservation(options.langfuseTrace ?? null, {
      model: openaiModel,
      provider: 'openai',
      input: convertMessagesToLangfuse(openaiMessages),
      output: convertOutputToLangfuse(collectedMessages),
      usage: {
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        cache_creation_input_tokens: usage.cache_creation_input_tokens,
        cache_read_input_tokens: usage.cache_read_input_tokens,
      },
      startTime: new Date(start),
      endTime: new Date(),
      completionStartTime: ttftMs > 0 ? new Date(start + ttftMs) : undefined,
      tools: convertToolsToLangfuse(toolSchemas as unknown[]),
      ...(enableThinking && { thinking: { type: 'enabled' } }),
    })

    // Safety: if stream ended without message_stop, assemble and yield whatever we have
    if (partialMessage) {
      for (const output of assembleFinalAssistantOutputs({
        partialMessage,
        contentBlocks,
        tools,
        agentId: options.agentId,
        usage,
        stopReason,
        maxTokens,
      })) {
        yield output
      }
    }
  } catch (error) {
    if (signal.aborted) return
    const errorMessage = repairUTF8Mojibake(
      error instanceof Error ? error.message : String(error),
    )
    logForDebugging(`[OpenAI] Error: ${errorMessage}`, { level: 'error' })
    // This is an internal fallback-chain sentinel: every route failed without
    // a classifiable cause. Name the condition instead of staying silent.
    if (errorMessage === 'all direct providers failed') {
      const failure = describeUpstreamFailure(error)
      yield createAssistantAPIErrorMessage({
        content: failure.content,
        apiError: 'api_error',
        error: failure.error,
        errorDetails: redactErrorText(errorMessage),
      })
      return
    }
    // CCB is already a fallback chain: every route has been exhausted. Still
    // report the concrete cause (gateway pool exhausted, 429, timeout, ...)
    // rather than a bare "No response requested.", or there is nothing left to
    // triage by hand. Upstream text is redacted before it reaches the UI.
    if (
      isCCBModel(options.model) ||
      isCCBRoutingModel(options.model) ||
      /^(?:ccb\/)?(?:advisor|lite|full|ultra|review|smart|opus)$/i.test(
        options.model.trim(),
      )
    ) {
      const failure = describeUpstreamFailure(error)
      yield createAssistantAPIErrorMessage({
        content: failure.content,
        apiError: 'api_error',
        error: failure.error,
        errorDetails: redactErrorText(errorMessage),
      })
      return
    }
    yield createAssistantAPIErrorMessage({
      content: `API Error: ${errorMessage}`,
      apiError: 'api_error',
      error: (error instanceof Error
        ? error
        : new Error(String(error))) as unknown as SDKAssistantMessageError,
    })
  }
}
