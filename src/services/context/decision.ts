import type { Message } from '../../types/message.js'
import { estimateTokens } from './compress.js'

export type CompressionDecisionInput = {
  messages: Message[]
  tokenUsage: number
  contextWindow: number
  turns: number
  hasToolResult: boolean
  llmDecision?: boolean
}

export type CompressionDecision = {
  shouldCompress: boolean
  reason: string
  shouldAskLlm: boolean
}

/** Accept only the exact JSON contract used by the optional decision query. */
export function parseCompressionDecision(raw: string): boolean | undefined {
  try {
    const value: unknown = JSON.parse(raw.trim())
    if (!value || typeof value !== 'object' || Array.isArray(value))
      return undefined
    const record = value as Record<string, unknown>
    return Object.keys(record).length === 1 &&
      typeof record.shouldCompress === 'boolean'
      ? record.shouldCompress
      : undefined
  } catch {
    return undefined
  }
}

function contentSize(message: Message): number {
  const content = (message as { message?: { content?: unknown } }).message
    ?.content
  return typeof content === 'string'
    ? estimateTokens(content)
    : Array.isArray(content)
      ? estimateTokens(JSON.stringify(content))
      : 0
}

export function hasToolResult(messages: Message[]): boolean {
  return messages.some(message => {
    if (message.type !== 'user') return false
    const content = (message as { message?: { content?: unknown } }).message
      ?.content
    return (
      Array.isArray(content) &&
      content.some(block =>
        Boolean(
          block &&
            typeof block === 'object' &&
            (block as { type?: string }).type === 'tool_result',
        ),
      )
    )
  })
}

export function decideCompression(
  input: CompressionDecisionInput,
): CompressionDecision {
  if (!input.hasToolResult)
    return {
      shouldCompress: false,
      reason: 'no-tool-result',
      shouldAskLlm: false,
    }
  if (input.turns < 3)
    return {
      shouldCompress: false,
      reason: 'too-few-turns',
      shouldAskLlm: false,
    }
  if (input.llmDecision === false)
    return {
      shouldCompress: false,
      reason: 'llm-declined',
      shouldAskLlm: false,
    }
  const usage =
    input.tokenUsage ||
    input.messages.reduce((sum, message) => sum + contentSize(message), 0)
  const ratio = input.contextWindow > 0 ? usage / input.contextWindow : 0
  if (input.llmDecision === true)
    return { shouldCompress: true, reason: 'llm-approved', shouldAskLlm: false }
  if (ratio >= 0.9)
    return {
      shouldCompress: true,
      reason: 'near-context-limit',
      shouldAskLlm: false,
    }
  return {
    shouldCompress: false,
    reason: 'below-threshold',
    shouldAskLlm: true,
  }
}
