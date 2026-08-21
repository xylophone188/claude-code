import OpenAI from 'openai'
import { openaiAdapter } from 'src/services/providerUsage/adapters/openai.js'
import { updateProviderBuckets } from 'src/services/providerUsage/store.js'
import {
  parseOmniRouteReceipt,
  recordOmniRouteError,
  updateAccountQuota,
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
): typeof fetch {
  const wrapped = async (
    ...args: Parameters<typeof fetch>
  ): Promise<Response> => {
    let res: Response
    try {
      res = await base(...args)
    } catch (error) {
      recordOmniRouteError(error)
      throw error
    }
    if (!res.ok) {
      recordOmniRouteError(`${res.status} ${res.statusText}`)
    }
    try {
      parseOmniRouteReceipt(res.headers)
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
}): OpenAI {
  if (cachedClient && !options?.baseURL && !options?.apiKey) return cachedClient

  const apiKey = options?.apiKey ?? process.env.OPENAI_API_KEY ?? ''
  const baseURL = options?.baseURL ?? process.env.OPENAI_BASE_URL

  const baseFetch = options?.fetchOverride ?? (globalThis.fetch as typeof fetch)
  const wrappedFetch = wrapFetchForUsage(
    baseFetch,
    options?.providerId,
    options?.accountId,
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
