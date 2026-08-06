import { describe, expect, test } from 'bun:test'
import type { ChatCompletionChunk } from 'openai/resources/chat/completions/completions.mjs'
import { createOpencodeFreeFetch, retryOpencodeFreeStream } from '../index.js'

function streamOf(
  ...events: ChatCompletionChunk[]
): AsyncIterable<ChatCompletionChunk> {
  return {
    async *[Symbol.asyncIterator]() {
      yield* events
    },
  }
}

const textChunk = (text: string) =>
  ({
    id: 'test',
    choices: [{ delta: { content: text }, finish_reason: null, index: 0 }],
    created: 0,
    model: 'test',
    object: 'chat.completion.chunk',
  }) as ChatCompletionChunk

const finishChunk = {
  id: 'test',
  choices: [{ delta: {}, finish_reason: 'stop', index: 0 }],
  created: 0,
  model: 'test',
  object: 'chat.completion.chunk',
} as ChatCompletionChunk

describe('createOpencodeFreeFetch', () => {
  test('rejects every non-200 response', async () => {
    const fetch = createOpencodeFreeFetch(
      (async () =>
        new Response('', { status: 201 })) as unknown as typeof fetch,
    )

    await expect(fetch('http://example.test')).rejects.toThrow('HTTP 201')
  })
})

describe('retryOpencodeFreeStream', () => {
  test('recreates request after an empty stream', async () => {
    let attempts = 0
    const events = []
    for await (const event of retryOpencodeFreeStream(async () => {
      attempts++
      return attempts === 1 ? streamOf(finishChunk) : streamOf(textChunk('ok'))
    })) {
      events.push(event)
    }

    expect(attempts).toBe(2)
    expect(events).toHaveLength(1)
    expect(
      (events[0] as { choices: [{ delta: { content: string } }] }).choices[0]
        .delta.content,
    ).toBe('ok')
  })

  test('retries stream creation errors', async () => {
    let attempts = 0
    const events = []
    for await (const event of retryOpencodeFreeStream(async () => {
      attempts++
      if (attempts === 1) throw new Error('HTTP 503')
      return streamOf(textChunk('ok'))
    })) {
      events.push(event)
    }

    expect(attempts).toBe(2)
    expect(events).toHaveLength(1)
    expect(
      (events[0] as { choices: [{ delta: { content: string } }] }).choices[0]
        .delta.content,
    ).toBe('ok')
  })

  test('throws after repeated empty streams (11 total tries = 1 + 10 retries)', async () => {
    let attempts = 0
    const consume = async () => {
      for await (const _event of retryOpencodeFreeStream(async () => {
        attempts++
        return streamOf(finishChunk)
      })) {
        // consume
      }
    }

    await expect(consume()).rejects.toThrow('empty stream')
    expect(attempts).toBe(11)
  })
})
