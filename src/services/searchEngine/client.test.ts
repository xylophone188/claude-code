import { test, expect, mock } from 'bun:test'
import { SearchEngineClient } from './client.js'

test('searchEngineClient uses Elasticsearch document and index paths', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  globalThis.fetch = mock(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, init })
      return new Response(JSON.stringify({ tagline: 'You know, for search' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    },
  ) as any

  const client = new SearchEngineClient({ host: 'http://es.test' })
  await client.indexDocument('memories', 'doc-1', { text: 'hello' })
  await client.search('memories', { text: 'hello', fields: ['text'] })
  await client.deleteDocument('memories', 'doc-1')

  expect(calls.map(call => call.url)).toEqual([
    'http://es.test/memories/_doc/doc-1',
    'http://es.test/memories/_search',
    'http://es.test/memories/_doc/doc-1',
  ])
  expect(calls[0]!.init?.method).toBe('PUT')
  expect(calls[2]!.init?.method).toBe('DELETE')
})
