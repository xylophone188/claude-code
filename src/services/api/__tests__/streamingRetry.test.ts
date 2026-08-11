/**
 * Tests for isRetriableStreamingConnectionError — the classifier that decides
 * whether a mid-stream failure should trigger a fresh streaming retry before
 * falling back to non-streaming. This is the gap that used to let a single
 * "Request timed out" kill the whole turn (e.g. the WeChat ClawBot channel).
 */
import { describe, expect, test } from 'bun:test'
import {
  APIConnectionError,
  APIConnectionTimeoutError,
  APIError,
} from '@anthropic-ai/sdk/error'
import { isRetriableStreamingConnectionError } from '../claude.js'

describe('isRetriableStreamingConnectionError', () => {
  test('retries SDK connection timeouts (the WeChat "Request timed out" case)', () => {
    expect(
      isRetriableStreamingConnectionError(
        new APIConnectionTimeoutError({ message: 'Request timed out' }),
      ),
    ).toBe(true)
  })

  test('retries generic connection errors (ECONNRESET / dropped socket)', () => {
    expect(
      isRetriableStreamingConnectionError(
        new APIConnectionError({ message: 'connection reset by peer' }),
      ),
    ).toBe(true)
  })

  test('retries the stream-idle watchdog timeout', () => {
    expect(
      isRetriableStreamingConnectionError(
        new Error('Stream idle timeout - no chunks received'),
      ),
    ).toBe(true)
  })

  test('retries a stream that ended with zero events (proxy returned empty)', () => {
    expect(
      isRetriableStreamingConnectionError(
        new Error('Stream ended without receiving any events'),
      ),
    ).toBe(true)
  })

  test('retries HTTP 408 (request timeout)', () => {
    const err = new APIError(408, undefined, 'Request Timeout', undefined)
    expect(isRetriableStreamingConnectionError(err)).toBe(true)
  })

  test('does NOT retry non-retriable API errors (400, 401, 500, etc.)', () => {
    expect(
      isRetriableStreamingConnectionError(
        new APIError(400, undefined, 'Bad Request', undefined),
      ),
    ).toBe(false)
    expect(
      isRetriableStreamingConnectionError(
        new APIError(500, undefined, 'Internal Server Error', undefined),
      ),
    ).toBe(false)
  })

  test('does NOT retry arbitrary errors', () => {
    expect(
      isRetriableStreamingConnectionError(new Error('some other failure')),
    ).toBe(false)
    expect(isRetriableStreamingConnectionError('a string')).toBe(false)
    expect(isRetriableStreamingConnectionError(null)).toBe(false)
    expect(isRetriableStreamingConnectionError(undefined)).toBe(false)
  })
})
