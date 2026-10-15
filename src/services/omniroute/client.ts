/**
 * Direct OpenAI-compatible outbound client.
 *
 * After the multi-factor scenario scorer picks a winner, this module sends
 * the request straight to the upstream `{baseUrl}/chat/completions` — no
 * intermediary gateways, no chained fallback.
 *
 * Success / failure / rate-limit signals are pushed back to Redis so the
 * next scoring pass has fresh data. Callers that need a stream use
 * `streamDirectCompletion`; callers that only need text use
 * `sendDirectCompletion`.
 */

import type { ChatCompletionChunk } from 'openai/resources/chat/completions/completions.mjs'
import {
  type CandidateView,
  detectScenario,
  type ScoredPick,
  scoreAndPick,
} from '../routing/scenarioScorer.js'
import {
  recordFailure,
  recordLatency,
  recordRateLimit,
  recordRequestStart,
  recordSuccess,
} from '../routing/runtimeSignals.js'
import { loadProvidersFromPG } from '../providerRegistry/pgLoader.js'
import { pgIsAvailable } from '../pg/pool.js'

export interface DirectCompletionRequest {
  messages: Array<
    | { role: 'system'; content: string }
    | { role: 'user'; content: string }
    | { role: 'assistant'; content: string }
    | { role: 'tool'; content: string; tool_call_id?: string; name?: string }
  >
  model?: string
  maxTokens?: number
  temperature?: number
  topP?: number
  stream?: boolean
  tools?: unknown[]
  toolChoice?: 'auto' | 'none' | 'required' | Record<string, unknown>
  reasoningEffort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  responseFormat?: Record<string, unknown>
  signal?: AbortSignal
  headers?: Record<string, string>
  timeoutMs?: number
}

export interface DirectCompletionResult {
  content: string
  usage?: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
  }
  provider: string
  model: string
  latencyMs: number
  finishReason?: string
}

export interface DirectCompletionError {
  status?: number
  message: string
  provider?: string
  model?: string
}

const DEFAULT_TIMEOUT_MS = 120_000

/**
 * High-level entry point: pick a model from PG + Redis, then send a direct
 * OpenAI-compatible request.
 */
export async function sendDirectCompletion(
  req: DirectCompletionRequest,
  opts: {
    providers?: Array<import('../providerRegistry/types.js').ProviderConfig>
    scenarioHint?: {
      prompt?: string
      messageCount?: number
      hasFileEdits?: boolean
      hasTestFiles?: boolean
      hasBugs?: boolean
      wantsReasoning?: boolean
      wantsVision?: boolean
      wantsTools?: boolean
      wantsLongContext?: boolean
      tokenBudget?: number
    }
  } = {},
): Promise<DirectCompletionResult> {
  const providers = opts.providers ?? (await loadProvidersFromPG())
  const { candidatesFromProviders } = await import(
    '../routing/scenarioScorer.js'
  )
  const candidates = candidatesFromProviders(providers)
  if (!candidates.length) {
    throw new Error('No upstream candidates available for direct completion.')
  }
  const scenario = detectScenario(
    opts.scenarioHint ?? { prompt: req.messages.at(-1)?.content },
  )
  const pick = await scoreAndPick(candidates, scenario)
  if (!pick) {
    throw new Error('Scenario scorer returned no viable candidate.')
  }
  return sendToCandidate(pick.candidate, req)
}

export async function streamDirectCompletion(
  pick: ScoredPick | CandidateView,
  req: DirectCompletionRequest,
): Promise<AsyncGenerator<ChatCompletionChunk>> {
  const candidate: CandidateView =
    'score' in pick
      ? {
          providerId: (pick as ScoredPick).candidate.providerId,
          modelId: (pick as ScoredPick).candidate.modelId,
          candidate: (pick as ScoredPick).candidate.candidate,
          baseUrl: (pick as ScoredPick).candidate.baseUrl,
          apiKey: (pick as ScoredPick).candidate.apiKey,
          headers: (pick as ScoredPick).candidate.headers,
          timeoutMs: (pick as ScoredPick).candidate.timeoutMs,
          compatRule: (pick as ScoredPick).candidate.compatRule,
        }
      : pick

  async function* generator(): AsyncGenerator<ChatCompletionChunk> {
    yield* streamToCandidate(candidate, req)
  }
  return generator()
}

export async function sendToCandidate(
  candidate: CandidateView,
  req: DirectCompletionRequest,
): Promise<DirectCompletionResult> {
  const started = await recordRequestStart(candidate.providerId)
  const start = performance.now()
  const url = `${candidate.baseUrl.replace(/\/+$/, '')}/chat/completions`
  const controller = new AbortController()
  const timeout = setTimeout(
    () => controller.abort(),
    req.timeoutMs ?? candidate.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  )
  const onOuterAbort = () => controller.abort()
  if (req.signal) {
    if (req.signal.aborted) controller.abort()
    else req.signal.addEventListener('abort', onOuterAbort, { once: true })
  }

  const body: Record<string, unknown> = {
    model: candidate.modelId,
    messages: req.messages,
    stream: false,
  }
  if (req.maxTokens) body.max_tokens = req.maxTokens
  if (req.temperature != null) body.temperature = req.temperature
  if (req.topP != null) body.top_p = req.topP
  if (req.tools && req.tools.length) body.tools = req.tools
  if (req.toolChoice != null) body.tool_choice = req.toolChoice
  if (req.reasoningEffort) body.reasoning_effort = req.reasoningEffort
  if (req.responseFormat) body.response_format = req.responseFormat
  if (candidate.compatRule === 'strict-openai') delete body.reasoning_effort

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json',
    ...candidate.headers,
    ...req.headers,
  }
  if (candidate.apiKey) headers.authorization = `Bearer ${candidate.apiKey}`

  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } catch (err) {
    clearTimeout(timeout)
    if (req.signal) req.signal.removeEventListener('abort', onOuterAbort)
    recordFailure(candidate.providerId, candidate.modelId, { severity: 0.6 })
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(
      `Direct completion to ${candidate.providerId}/${candidate.modelId} failed: ${message}`,
    )
  }
  const latencyMs = Math.round(performance.now() - start)

  if (!response.ok) {
    const text = await response.text().catch(() => '')
    clearTimeout(timeout)
    if (req.signal) req.signal.removeEventListener('abort', onOuterAbort)
    if (response.status === 429) {
      recordRateLimit(candidate.providerId, undefined)
    } else {
      recordFailure(candidate.providerId, candidate.modelId, {
        severity: response.status >= 500 ? 0.8 : 0.5,
      })
    }
    throw new Error(
      `Direct completion ${candidate.providerId}/${candidate.modelId} returned HTTP ${response.status}: ${text.slice(0, 400)}`,
    )
  }

  const json = (await response.json()) as {
    choices?: Array<{
      message?: { content?: string; tool_calls?: unknown[] }
      finish_reason?: string
    }>
    usage?: {
      prompt_tokens?: number
      completion_tokens?: number
      total_tokens?: number
    }
  }
  clearTimeout(timeout)
  if (req.signal) req.signal.removeEventListener('abort', onOuterAbort)

  const content = json.choices?.[0]?.message?.content ?? ''
  const usage = json.usage
    ? {
        promptTokens: json.usage.prompt_tokens ?? 0,
        completionTokens: json.usage.completion_tokens ?? 0,
        totalTokens: json.usage.total_tokens ?? 0,
      }
    : undefined

  recordLatency(candidate.providerId, candidate.modelId, latencyMs)
  recordSuccess(candidate.providerId, candidate.modelId, {
    healthBump: 0.03,
  }).catch(() => undefined)

  if (started === 1) {
    // first request this minute — surface for logging only, no-op here
  }

  return {
    content,
    usage,
    provider: candidate.providerId,
    model: candidate.modelId,
    latencyMs,
    finishReason: json.choices?.[0]?.finish_reason,
  }
}

async function* streamToCandidate(
  candidate: CandidateView,
  req: DirectCompletionRequest,
): AsyncGenerator<ChatCompletionChunk> {
  const start = performance.now()
  const controller = new AbortController()
  const timeout = setTimeout(
    () => controller.abort(),
    req.timeoutMs ?? candidate.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  )
  const onOuterAbort = () => controller.abort()
  if (req.signal) {
    if (req.signal.aborted) controller.abort()
    else req.signal.addEventListener('abort', onOuterAbort, { once: true })
  }
  const url = `${candidate.baseUrl.replace(/\/+$/, '')}/chat/completions`
  const body: Record<string, unknown> = {
    model: candidate.modelId,
    messages: req.messages,
    stream: true,
  }
  if (req.maxTokens) body.max_tokens = req.maxTokens
  if (req.temperature != null) body.temperature = req.temperature
  if (req.topP != null) body.top_p = req.topP
  if (req.tools && req.tools.length) body.tools = req.tools
  if (req.toolChoice != null) body.tool_choice = req.toolChoice
  if (req.reasoningEffort && candidate.compatRule !== 'strict-openai')
    body.reasoning_effort = req.reasoningEffort

  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'text/event-stream',
    ...candidate.headers,
    ...req.headers,
  }
  if (candidate.apiKey) headers.authorization = `Bearer ${candidate.apiKey}`

  let response: Response
  try {
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    })
  } catch (err) {
    clearTimeout(timeout)
    if (req.signal) req.signal.removeEventListener('abort', onOuterAbort)
    recordFailure(candidate.providerId, candidate.modelId, { severity: 0.6 })
    throw err
  }
  if (!response.ok || !response.body) {
    const text = await response.text().catch(() => '')
    clearTimeout(timeout)
    if (req.signal) req.signal.removeEventListener('abort', onOuterAbort)
    if (response.status === 429)
      recordRateLimit(candidate.providerId, candidate.accountId)
    else
      recordFailure(candidate.providerId, candidate.modelId, { severity: 0.5 })
    throw new Error(
      `Direct stream ${candidate.providerId}/${candidate.modelId} HTTP ${response.status}: ${text.slice(0, 400)}`,
    )
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let firstChunkAt = start
  let lastChunkAt = start
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      if (firstChunkAt === start) firstChunkAt = performance.now()
      lastChunkAt = performance.now()
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const raw of lines) {
        const line = raw.trim()
        if (!line || line.startsWith(':')) continue
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (!payload || payload === '[DONE]') continue
        try {
          const chunk = JSON.parse(payload) as ChatCompletionChunk
          yield chunk
        } catch {
          // skip malformed chunk
        }
      }
    }
  } finally {
    clearTimeout(timeout)
    if (req.signal) req.signal.removeEventListener('abort', onOuterAbort)
    const latencyMs = Math.round(performance.now() - start)
    recordLatency(candidate.providerId, candidate.modelId, latencyMs)
    recordSuccess(candidate.providerId, candidate.modelId).catch(
      () => undefined,
    )
    void lastChunkAt
  }
}

/**
 * Utility: check whether PG/Redis are reachable so callers can decide
 * whether the deep multi-factor path is worth trying at all.
 */
export async function pgReachable(): Promise<boolean> {
  return pgIsAvailable()
}
