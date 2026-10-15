import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import { setupAxiosMock } from '../../../../../../tests/mocks/axios'

// Restore real axios mock at end so per-test stubs don't leak to other files.
afterAll(() => {
  setupAxiosMock()
})

const _abortMock = () => ({
  AbortError: class AbortError extends Error {
    constructor(message?: string) {
      super(message)
      this.name = 'AbortError'
    }
  },
  isAbortError: (e: unknown) =>
    e instanceof Error && (e as Error).name === 'AbortError',
})
mock.module('src/utils/errors.js', _abortMock)
mock.module('src/utils/errors', _abortMock)

// Settings mock — empty object; tests drive behavior via env vars which take
// priority in the adapter's getBaseUrl/getApiKey helpers.
mock.module('src/utils/settings/settings.js', () => ({
  getSettings_DEPRECATED: () => ({}),
  getSettings: () => ({}),
}))

import { OmnirouteSearchAdapter } from '../adapters/omnirouteAdapter'

const ORIGINAL_BASE_URL = process.env.OMNIROUTE_WEB_TOOLS_BASE_URL
const ORIGINAL_API_KEY = process.env.OMNIROUTE_WEB_TOOLS_API_KEY

beforeAll(() => {
  process.env.OMNIROUTE_WEB_TOOLS_BASE_URL = 'http://test-omniroute.local:8888'
  process.env.OMNIROUTE_WEB_TOOLS_API_KEY = 'test-key-123'
})

afterAll(() => {
  if (ORIGINAL_BASE_URL === undefined) {
    delete process.env.OMNIROUTE_WEB_TOOLS_BASE_URL
  } else {
    process.env.OMNIROUTE_WEB_TOOLS_BASE_URL = ORIGINAL_BASE_URL
  }
  if (ORIGINAL_API_KEY === undefined) {
    delete process.env.OMNIROUTE_WEB_TOOLS_API_KEY
  } else {
    process.env.OMNIROUTE_WEB_TOOLS_API_KEY = ORIGINAL_API_KEY
  }
})

describe('OmnirouteSearchAdapter', () => {
  test('POSTs to /v1/search with Bearer auth and maps results', async () => {
    const axiosHandle = setupAxiosMock()
    let capturedUrl: string | undefined
    let capturedBody: unknown
    let capturedHeaders: unknown
    axiosHandle.stubs.post = (url: string, body: unknown, config: unknown) => {
      capturedUrl = url
      capturedBody = body
      const cfg = config as { headers?: unknown }
      capturedHeaders = cfg?.headers
      return Promise.resolve({
        status: 200,
        statusText: 'OK',
        data: {
          results: [
            { title: 'Hit 1', url: 'https://example.com/1', snippet: 'snip1' },
            {
              title: 'Hit 2',
              url: 'https://example.com/2',
              content: 'content2',
            },
          ],
        },
        headers: {},
        config: {},
      })
    }
    axiosHandle.useStubs = true

    try {
      const adapter = new OmnirouteSearchAdapter()
      const results = await adapter.search('hello world', {
        numResults: 5,
        allowedDomains: ['example.com'],
        blockedDomains: ['bad.com'],
      })

      expect(capturedUrl).toBe('http://test-omniroute.local:8888/v1/search')
      expect(capturedBody).toEqual({
        query: 'hello world',
        max_results: 5,
        search_type: 'auto',
        filters: {
          include_domains: ['example.com'],
          exclude_domains: ['bad.com'],
        },
      })
      const headers = capturedHeaders as Record<string, string>
      expect(headers.Authorization).toBe('Bearer test-key-123')
      expect(headers['Content-Type']).toBe('application/json')
      expect(results).toEqual([
        { title: 'Hit 1', url: 'https://example.com/1', snippet: 'snip1' },
        {
          title: 'Hit 2',
          url: 'https://example.com/2',
          snippet: 'content2',
        },
      ])
    } finally {
      axiosHandle.useStubs = false
    }
  })

  test('falls back to data array when results is missing', async () => {
    const axiosHandle = setupAxiosMock()
    axiosHandle.stubs.post = () =>
      Promise.resolve({
        status: 200,
        statusText: 'OK',
        data: {
          data: [
            {
              title: 'Alt',
              url: 'https://alt.example.com',
              snippet: 'alt-snip',
            },
          ],
        },
        headers: {},
        config: {},
      })
    axiosHandle.useStubs = true
    try {
      const adapter = new OmnirouteSearchAdapter()
      const results = await adapter.search('alt', {})
      expect(results.length).toBe(1)
      expect(results[0].url).toBe('https://alt.example.com')
    } finally {
      axiosHandle.useStubs = false
    }
  })

  test('skips hits without a url', async () => {
    const axiosHandle = setupAxiosMock()
    axiosHandle.stubs.post = () =>
      Promise.resolve({
        status: 200,
        statusText: 'OK',
        data: {
          results: [
            { title: 'NoUrl', snippet: 'x' },
            { title: 'HasUrl', url: 'https://ok.example.com' },
          ],
        },
        headers: {},
        config: {},
      })
    axiosHandle.useStubs = true
    try {
      const adapter = new OmnirouteSearchAdapter()
      const results = await adapter.search('q', {})
      expect(results.length).toBe(1)
      expect(results[0].url).toBe('https://ok.example.com')
    } finally {
      axiosHandle.useStubs = false
    }
  })

  test('throws on non-2xx response', async () => {
    const axiosHandle = setupAxiosMock()
    axiosHandle.stubs.post = () =>
      Promise.reject({
        isAxiosError: true,
        response: { status: 500, statusText: 'Server Error', data: {} },
        message: 'Request failed with status code 500',
      })
    axiosHandle.stubs.isAxiosError = () => true
    axiosHandle.stubs.isCancel = () => false
    axiosHandle.useStubs = true
    try {
      const adapter = new OmnirouteSearchAdapter()
      await expect(adapter.search('boom', {})).rejects.toThrow()
    } finally {
      axiosHandle.useStubs = false
    }
  })

  test('aborts when signal already aborted', async () => {
    const axiosHandle = setupAxiosMock()
    axiosHandle.stubs.post = () =>
      Promise.resolve({
        status: 200,
        statusText: 'OK',
        data: { results: [] },
        headers: {},
        config: {},
      })
    axiosHandle.useStubs = true
    try {
      const adapter = new OmnirouteSearchAdapter()
      const controller = new AbortController()
      controller.abort()
      await expect(
        adapter.search('q', { signal: controller.signal }),
      ).rejects.toThrow()
    } finally {
      axiosHandle.useStubs = false
    }
  })

  test('emits query_update then search_results_received progress', async () => {
    const axiosHandle = setupAxiosMock()
    axiosHandle.stubs.post = () =>
      Promise.resolve({
        status: 200,
        statusText: 'OK',
        data: {
          results: [{ title: 'A', url: 'https://a.example.com', snippet: 's' }],
        },
        headers: {},
        config: {},
      })
    axiosHandle.useStubs = true
    try {
      const adapter = new OmnirouteSearchAdapter()
      const events: { type: string; query?: string; resultCount?: number }[] =
        []
      await adapter.search('q', {
        onProgress: e =>
          events.push(
            e as { type: string; query?: string; resultCount?: number },
          ),
      })
      expect(events[0].type).toBe('query_update')
      expect(events[0].query).toBe('q')
      expect(events[1].type).toBe('search_results_received')
      expect(events[1].resultCount).toBe(1)
    } finally {
      axiosHandle.useStubs = false
    }
  })
})
