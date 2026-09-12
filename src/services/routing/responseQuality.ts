/**
 * responseQuality.ts — response semantics gate for routed OpenAI-compatible
 * completions.
 *
 * HTTP 200 is not a quality signal. Upstream gateways routinely return 200
 * bodies containing moderation messages, JSON error envelopes, HTML pages,
 * repeated-character junk, or completely empty streams. This module turns
 * those shapes into an explicit verdict so routers can reject a completion
 * before it reaches the transcript.
 *
 * PURE and in-memory: no network, timers, DOM parsing, or module state. Callers
 * own evidence collection from their stream or buffered response.
 */

export type QualityVerdict = 'ok' | 'reject'

export type QualityReason =
  | 'ok'
  | 'empty'
  | 'fake200'
  | 'junk'
  | 'truncated-tool-call'

export interface StreamEvidence {
  text?: string
  toolCalls?: unknown[]
  chunkCount?: number
  eventCount?: number
  status?: number
}

export interface ResponseQualityConfig {
  /** Minimum visible characters required when no tool call is present. Default 30. */
  minLength?: number
  /** Reject non-JSON fake-200 text below this size. Default 256. */
  fakeBodyLimit?: number
  /** Allow a short text-only completion when tool calls are present. Default true. */
  allowToolCallOnly?: boolean
}

const DEFAULT_MIN_LENGTH = 30
const DEFAULT_FAKE_BODY_LIMIT = 256
const JUNK_RUN_START = 80
const JUNK_RUN_RE = /^(.{1,8})\1{9,}$/s
const HTML_HINT_RE = /<\s*(?:html|body|head|pre|script|div|p)\b/i
const TRUNCATED_ERROR_RE = /error\s*[:：]|exception|traceback|stack\s*trace/i
const TRUNCATED_LIMIT_RE =
  /(?:token|context|length|maximum|limit)s?\s+(?:was\s+)?(?:exceeded|exceed|reached)/i

const UPSTREAM_CUSTOM_ERROR_PATTERNS: RegExp[] = [
  /抱歉，系统检测到您当前输入的信息存在敏感内容/,
  /(?:抱歉|对不起)，?系统检测到.{0,50}(?:敏感|违规|异常)内容/,
  /系统检测到.{0,30}(?:敏感|违规)内容.{0,40}(?:无法|拒绝)响应/,
  /无法响应(?:您|你)的请求.{0,20}(?:请.{0,10}(?:检查|重新输入|重试|稍后再试))/,
]

export interface QualityResult {
  verdict: QualityVerdict
  reason: QualityReason
  detail?: string
}

export function isJunkContent(text: string): boolean {
  const compact = text.trim()
  if (!compact) return true
  if (containsReplacementCharacter(compact)) return true
  if (containsControlCharacter(compact)) return true
  const squeezed = compact.replace(/\s+/g, '')
  if (squeezed.length < JUNK_RUN_START) return false
  return JUNK_RUN_RE.test(squeezed)
}

export function isFakeSuccessBody(
  text: string,
  config: ResponseQualityConfig = {},
): boolean {
  const cfg = normalizeConfig(config)
  const compact = text.trim()
  if (!compact) return false
  if (UPSTREAM_CUSTOM_ERROR_PATTERNS.some(pattern => pattern.test(compact))) {
    return true
  }
  if (isErrorJsonEnvelope(compact)) return true
  if (HTML_HINT_RE.test(compact)) return true
  return compact.length <= cfg.fakeBodyLimit && isTruncatedFailureText(compact)
}

export function validateResponseQuality(
  evidence: StreamEvidence,
  config: ResponseQualityConfig = {},
): QualityResult {
  const cfg = normalizeConfig(config)
  const text = evidence.text ?? ''
  const toolCalls = Array.isArray(evidence.toolCalls) ? evidence.toolCalls : []
  const deliveredEvidence =
    (evidence.chunkCount ?? 0) > 0 ||
    (evidence.eventCount ?? 0) > 0 ||
    text.trim().length > 0 ||
    toolCalls.length > 0

  if (!deliveredEvidence) {
    return { verdict: 'reject', reason: 'empty', detail: 'no stream output' }
  }

  if (isFakeSuccessBody(text, cfg)) {
    return { verdict: 'reject', reason: 'fake200' }
  }

  if (!hasCompleteToolCall(toolCalls[0])) {
    return {
      verdict: 'reject',
      reason: 'truncated-tool-call',
      detail: 'incomplete tool call arguments',
    }
  }

  if (cfg.allowToolCallOnly && toolCalls.length > 0) {
    return { verdict: 'ok', reason: 'ok' }
  }

  if (isJunkContent(text)) {
    return { verdict: 'reject', reason: 'junk' }
  }

  if (text.trim().length < cfg.minLength) {
    return {
      verdict: 'reject',
      reason: 'junk',
      detail: 'response is too short to be useful',
    }
  }

  return { verdict: 'ok', reason: 'ok' }
}

function normalizeConfig(
  config: ResponseQualityConfig,
): Required<ResponseQualityConfig> {
  return {
    minLength: DEFAULT_MIN_LENGTH,
    fakeBodyLimit: DEFAULT_FAKE_BODY_LIMIT,
    allowToolCallOnly: true,
    ...config,
  }
}

function hasCompleteToolCall(toolCall: unknown): boolean {
  if (!toolCall) return true
  if (typeof toolCall !== 'object' || Array.isArray(toolCall)) return false
  const record = toolCall as Record<string, unknown>
  if (record.type && record.type !== 'function') return false
  if (!record.function) return false
  const fn = record.function
  if (typeof fn !== 'object' || fn === null) return false
  const functionCall = fn as Record<string, unknown>
  return typeof functionCall.name === 'string' && functionCall.name.length > 0
}

function isErrorJsonEnvelope(text: string): boolean {
  if (!text.trimStart().startsWith('{')) return false
  try {
    const parsed = JSON.parse(text)
    return isErrorObject(parsed)
  } catch {
    return false
  }
}

function isErrorObject(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const record = value as Record<string, unknown>
  if (isErrorRecord(record)) return true
  return Object.values(record).some(isErrorObject)
}

function isErrorRecord(record: Record<string, unknown>): boolean {
  const error = record.error
  if (!error || typeof error !== 'object' || Array.isArray(error)) return false
  const errorRecord = error as Record<string, unknown>
  return (
    typeof errorRecord.message === 'string' ||
    typeof errorRecord.code === 'string' ||
    typeof errorRecord.type === 'string'
  )
}

function containsReplacementCharacter(text: string): boolean {
  return text.includes('\u{FFFD}')
}

function containsControlCharacter(text: string): boolean {
  return [...text].some(character => {
    const code = character.charCodeAt(0)
    return code < 32 && ![9, 10, 13].includes(code)
  })
}

function isTruncatedFailureText(text: string): boolean {
  return TRUNCATED_ERROR_RE.test(text) || TRUNCATED_LIMIT_RE.test(text)
}
