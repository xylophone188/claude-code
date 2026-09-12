import OpenAI from 'openai'
import { openaiAdapter } from 'src/services/providerUsage/adapters/openai.js'
import { updateProviderBuckets } from 'src/services/providerUsage/store.js'
import {
  parseOmniRouteReceipt,
  recordOmniRouteError,
  updateAccountQuota,
  type DirectRoute,
} from '../../omniroute/adapter.js'
import { getProxyFetchOptions } from 'src/utils/proxy.js'

/**
 * Environment variables:
 *
 * OPENAI_API_KEY: Required. API key for the OpenAI-compatible endpoint.
 * OPENAI_BASE_URL: Recommended. Base URL for the endpoint (e.g. http://localhost:11434/v1).
 * OPENAI_ORG_ID: Optional. Organization ID.
 * OPENAI_PROJECT_ID: Optional. Project ID.
 */

let cachedClient: OpenAI | null = null

const OMNIROUTE_RECEIPT_HEADERS = new Set([
  'x-omniroute-request-id',
  'x-omniroute-provider',
  'x-omniroute-model',
  'x-omniroute-latency-ms',
  'x-omniroute-fallback-attempts',
  'x-omniroute-compression',
  'x-omniroute-decision',
  'x-omniroute-cognitive-task',
  'x-omniroute-cognitive-pool',
  'x-omniroute-cognitive-context',
  'x-omniroute-cognitive-effort',
  'x-omniroute-cache',
  'x-omniroute-cache-hit',
  'x-omniroute-context-project',
  'x-omniroute-context-project-source',
  'x-omniroute-context-sources',
  'x-omniroute-context-cache',
  'x-omniroute-context-bundle',
  'x-omniroute-context-tokens',
  'x-omniroute-context-fingerprint',
  'x-omniroute-context-cache-hit',
  'x-omniroute-routing-reason',
  'x-omniroute-cache-debug',
])
const MAX_OMNIROUTE_RECEIPT_BYTES = 64 * 1024
// biome-ignore lint/suspicious/noControlCharactersInRegex: receipt sanitization must strip control chars from upstream headers
const CONTROL_CHARACTERS = /[\x00-\x1f\x7f]/

/**
 * A slow OmniRoute stream is committed by its keepalive wrapper before the
 * upstream response is available. HTTP receipt headers cannot then be added,
 * so OmniRoute sends them as leading SSE comments. Read its clone until the
 * first normal SSE field, leaving the SDK's original response untouched.
 */
export async function observeOmniRouteSseReceipt(
  response: Response,
): Promise<void> {
  if (
    !response.body ||
    !response.headers.get('content-type')?.includes('text/event-stream')
  ) {
    return
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const headers = new Headers()
  let buffer = ''
  let byteCount = 0
  let received = false

  const record = (line: string): void => {
    const match = line.match(/^:\s*(x-omniroute-[a-z0-9-]+)=(.*)$/i)
    if (!match) return
    const name = match[1].toLowerCase()
    const value = match[2]
    if (
      !OMNIROUTE_RECEIPT_HEADERS.has(name) ||
      value.length > 16_384 ||
      CONTROL_CHARACTERS.test(value)
    ) {
      return
    }
    headers.set(name, value)
    received = true
  }

  const finish = (): void => {
    if (received) parseOmniRouteReceipt(headers)
  }

  try {
    while (byteCount < MAX_OMNIROUTE_RECEIPT_BYTES) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      byteCount += value.byteLength
      buffer += decoder.decode(value, { stream: true })
      let newline = buffer.indexOf('\n')
      while (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '')
        buffer = buffer.slice(newline + 1)
        if (line.startsWith(':')) {
          record(line)
        } else if (line) {
          finish()
          await reader.cancel()
          return
        }
        newline = buffer.indexOf('\n')
      }
    }
    if (buffer.startsWith(':')) record(buffer.replace(/\r$/, ''))
    finish()
  } catch {
    // Receipt observability must never alter a model stream.
  } finally {
    await reader.cancel().catch(() => {})
  }
}

/**
 * Wrap a fetch so that every response's rate-limit headers are fed into the
 * provider usage store. Errors in parsing must never break the request.
 *
 * The cast to `typeof fetch` is safe: OpenAI SDK only calls the function form,
 * not the static `preconnect` method that Bun/Node's `fetch` type declares.
 */
function wrapFetchForUsage(
  base: typeof fetch,
  providerId?: string,
  accountId?: string,
  receiptPolicy?: DirectRoute['receiptPolicy'],
): typeof fetch {
  const wrapped = async (
    ...args: Parameters<typeof fetch>
  ): Promise<Response> => {
    let res: Response
    try {
      res = await base(...args)
    } catch (error) {
      // Only record OmniRoute network/HTTP errors for routes with receiptPolicy omniroute or omniroute-9router
      if (
        receiptPolicy === 'omniroute' ||
        receiptPolicy === 'omniroute-9router'
      ) {
        recordOmniRouteError(error)
      }
      throw error
    }
    if (!res.ok) {
      if (
        receiptPolicy === 'omniroute' ||
        receiptPolicy === 'omniroute-9router'
      ) {
        recordOmniRouteError(`${res.status} ${res.statusText}`)
      }
    }
    try {
      // Only parse/observe OmniRoute receipt for routes with receiptPolicy omniroute or omniroute-9router
      if (
        receiptPolicy === 'omniroute' ||
        receiptPolicy === 'omniroute-9router'
      ) {
        parseOmniRouteReceipt(res.headers)
        if (
          providerId === 'omniroute' &&
          res.body &&
          !res.headers.has('x-omniroute-cognitive-pool')
        ) {
          // `clone()` tees the stream. The OpenAI SDK gets `res`; this detached
          // observer consumes only leading SSE comments from the other branch.
          void observeOmniRouteSseReceipt(res.clone())
        }
      }
      const buckets = openaiAdapter.parseHeaders(res.headers)
      updateProviderBuckets(providerId ?? 'openai', buckets)
      if (providerId && accountId && buckets.length) {
        updateAccountQuota(
          providerId,
          accountId,
          Math.min(...buckets.map(bucket => (1 - bucket.utilization) * 100)),
        )
      }
    } catch {
      // Ignore — usage tracking must not affect the request path.
    }
    return res
  }
  return wrapped as unknown as typeof fetch
}

export function getOpenAIClient(options?: {
  maxRetries?: number
  fetchOverride?: typeof fetch
  source?: string
  baseURL?: string
  apiKey?: string
  defaultHeaders?: Record<string, string>
  timeoutMs?: number
  providerId?: string
  accountId?: string
  receiptPolicy?: DirectRoute['receiptPolicy']
}): OpenAI {
  if (cachedClient && !options?.baseURL && !options?.apiKey) return cachedClient

  const apiKey = options?.apiKey ?? process.env.OPENAI_API_KEY ?? ''
  const baseURL = options?.baseURL ?? process.env.OPENAI_BASE_URL

  const baseFetch = options?.fetchOverride ?? (globalThis.fetch as typeof fetch)
  const wrappedFetch = wrapFetchForUsage(
    baseFetch,
    options?.providerId,
    options?.accountId,
    options?.receiptPolicy,
  )

  const client = new OpenAI({
    apiKey,
    ...(baseURL && { baseURL }),
    ...(options?.defaultHeaders && { defaultHeaders: options.defaultHeaders }),
    maxRetries: options?.maxRetries ?? 0,
    timeout:
      options?.timeoutMs ??
      parseInt(process.env.API_TIMEOUT_MS || String(600 * 1000), 10),
    dangerouslyAllowBrowser: true,
    ...(process.env.OPENAI_ORG_ID && {
      organization: process.env.OPENAI_ORG_ID,
    }),
    ...(process.env.OPENAI_PROJECT_ID && {
      project: process.env.OPENAI_PROJECT_ID,
    }),
    fetchOptions: getProxyFetchOptions({ forAnthropicAPI: false }),
    fetch: wrappedFetch,
  })

  if (!options?.fetchOverride) {
    cachedClient = client
  }

  return client
}

/** Clear the cached client (useful when env vars change). */
export function clearOpenAIClientCache(): void {
  cachedClient = null
}
