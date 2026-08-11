import { describe, expect, it } from 'bun:test'
import type { Message } from '../../../types/message.js'
import {
  decideCompression,
  hasToolResult,
  parseCompressionDecision,
} from '../decision.js'

const toolResult = {
  type: 'user',
  message: { content: [{ type: 'tool_result', content: 'ok' }] },
} as unknown as Message

describe('compression decision', () => {
  it('requires a completed tool batch and three turns', () => {
    expect(hasToolResult([toolResult])).toBe(true)
    expect(
      decideCompression({
        messages: [toolResult],
        tokenUsage: 1,
        contextWindow: 100,
        turns: 2,
        hasToolResult: true,
      }).shouldAskLlm,
    ).toBe(false)
    expect(
      decideCompression({
        messages: [],
        tokenUsage: 1,
        contextWindow: 100,
        turns: 3,
        hasToolResult: false,
      }).reason,
    ).toBe('no-tool-result')
  })

  it('keeps hard protection independent from the optional LLM decision', () => {
    expect(
      decideCompression({
        messages: [toolResult],
        tokenUsage: 95,
        contextWindow: 100,
        turns: 3,
        hasToolResult: true,
      }),
    ).toMatchObject({ shouldCompress: true, shouldAskLlm: false })
    expect(
      decideCompression({
        messages: [toolResult],
        tokenUsage: 50,
        contextWindow: 100,
        turns: 3,
        hasToolResult: true,
        llmDecision: false,
      }).shouldCompress,
    ).toBe(false)
    expect(
      decideCompression({
        messages: [toolResult],
        tokenUsage: 50,
        contextWindow: 100,
        turns: 3,
        hasToolResult: true,
        llmDecision: true,
      }).reason,
    ).toBe('llm-approved')
  })

  it('parses only the exact JSON contract', () => {
    expect(parseCompressionDecision('{"shouldCompress":true}')).toBe(true)
    expect(parseCompressionDecision('{"shouldCompress":false}')).toBe(false)
    expect(
      parseCompressionDecision('```json\n{"shouldCompress":true}\n```'),
    ).toBeUndefined()
    expect(
      parseCompressionDecision('{"shouldCompress":true,"extra":1}'),
    ).toBeUndefined()
  })
})
