import { describe, test, expect } from 'bun:test'
import { buildEventFrame } from '../eventStream.js'
import { kiroEventStreamToChunks } from '../kiro.js'
import type { ChatCompletionChunk } from 'openai/resources/chat/completions'

function eventStreamFromEvents(
  events: Array<{ type: string; payload: unknown; headerName?: string }>,
): ReadableStream<Uint8Array> {
  const frames = events.map(e =>
    buildEventFrame(
      [{ name: e.headerName ?? ':event-type', type: 7, value: e.type }],
      e.payload as Record<string, unknown>,
    ),
  )
  let i = 0
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= frames.length) {
        controller.close()
        return
      }
      controller.enqueue(frames[i++])
    },
  })
}

async function collect(
  events: Array<{ type: string; payload: unknown; headerName?: string }>,
): Promise<{ chunks: ChatCompletionChunk[]; error: Error | null }> {
  const chunks: ChatCompletionChunk[] = []
  let error: Error | null = null
  await kiroEventStreamToChunks(
    eventStreamFromEvents(events),
    'claude-opus-5',
    {
      onChunk: c => chunks.push(c),
      onError: e => {
        error = e
      },
    },
  )
  return { chunks, error }
}

describe('kiroEventStreamToChunks', () => {
  test('maps assistantResponseEvent content into streamed chunks', async () => {
    const { chunks, error } = await collect([
      { type: 'assistantResponseEvent', payload: { content: 'Hello' } },
      { type: 'messageStopEvent', payload: { stopReason: 'end_turn' } },
    ])
    expect(error).toBeNull()
    expect(chunks[0]?.choices[0]?.delta?.role).toBe('assistant')
    expect(chunks[0]?.choices[0]?.delta?.content).toBe('Hello')
    const last = chunks[chunks.length - 1]
    expect(last?.choices[0]?.finish_reason).toBe('stop')
  })

  test('maps reasoningContentEvent to reasoning_content', async () => {
    const { chunks, error } = await collect([
      {
        type: 'reasoningContentEvent',
        payload: { reasoningContentEvent: { text: 'thinking' } },
      },
      { type: 'assistantResponseEvent', payload: { content: 'answer' } },
      { type: 'messageStopEvent', payload: { stopReason: 'end_turn' } },
    ])
    expect(error).toBeNull()
    expect(
      chunks.some(
        c =>
          (c.choices[0]?.delta as Record<string, unknown>)
            ?.reasoning_content === 'thinking',
      ),
    ).toBe(true)
    expect(chunks.some(c => c.choices[0]?.delta?.content === 'answer')).toBe(
      true,
    )
  })

  test('emits tool_calls from toolUseEvent', async () => {
    const { chunks, error } = await collect([
      {
        type: 'toolUseEvent',
        payload: { name: 'search', toolUseId: 't1', input: { query: 'x' } },
      },
      { type: 'messageStopEvent', payload: { stopReason: 'tool_use' } },
    ])
    expect(error).toBeNull()
    const toolCallChunks = chunks.filter(
      c => (c.choices[0]?.delta as Record<string, unknown>)?.tool_calls,
    )
    expect(toolCallChunks.length).toBeGreaterThan(0)
    const finish = chunks[chunks.length - 1]
    expect(finish?.choices[0]?.finish_reason).toBe('tool_calls')
  })

  test('emits a usage block from metricsEvent', async () => {
    const { chunks, error } = await collect([
      { type: 'assistantResponseEvent', payload: { content: 'hi' } },
      {
        type: 'metricsEvent',
        payload: { metricsEvent: { inputTokens: 10, outputTokens: 5 } },
      },
      { type: 'messageStopEvent', payload: { stopReason: 'end_turn' } },
    ])
    expect(error).toBeNull()
    const withUsage = chunks.find(c => c.usage)
    expect(withUsage?.usage?.prompt_tokens).toBe(10)
    expect(withUsage?.usage?.completion_tokens).toBe(5)
    expect(withUsage?.usage?.total_tokens).toBe(15)
  })

  test('surfaces an upstream error event', async () => {
    const { chunks, error } = await collect([
      { type: 'assistantResponseEvent', payload: { content: 'partial' } },
      {
        type: 'error',
        payload: { message: 'boom' },
        headerName: ':message-type',
      },
    ])
    expect(error).not.toBeNull()
    expect(error?.message).toContain('boom')
    // No clean finish_reason emitted on error.
    expect(chunks.some(c => c.choices[0]?.finish_reason)).toBe(false)
  })

  test('fails on a truncated EventStream frame', async () => {
    // Feed an incomplete frame (only the prelude + a few header bytes) so the
    // decoder ends with a partial frame instead of a clean terminal event.
    const frame = buildEventFrame(
      [{ name: ':event-type', type: 7, value: 'assistantResponseEvent' }],
      { content: 'hi' },
    )
    const truncated = frame.subarray(0, 10)
    const chunks: ChatCompletionChunk[] = []
    let error: Error | null = null
    await kiroEventStreamToChunks(
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(truncated)
          c.close()
        },
      }),
      'claude-opus-5',
      {
        onChunk: c => chunks.push(c),
        onError: e => {
          error = e
        },
      },
    )
    expect(error).not.toBeNull()
    const errMsg = (error as Error | null)?.message ?? ''
    expect(errMsg).toMatch(/truncated frame|CRC mismatch|frame bounds/)
  })
})
