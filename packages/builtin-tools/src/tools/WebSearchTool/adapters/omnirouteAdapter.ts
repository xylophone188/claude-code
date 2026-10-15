/**
 * OmniRoute-based search adapter — POSTs to /v1/search on a configurable
 * OmniRoute web-tools gateway and maps results to SearchResult[].
 *
 * Endpoint and API key are sourced from settings (omniRouteWebToolsBaseUrl /
 * omniRouteWebToolsApiKey) or env overrides (OMNIROUTE_WEB_TOOLS_BASE_URL /
 * OMNIROUTE_WEB_TOOLS_API_KEY). Authorization: Bearer <key>.
 */

import axios from 'axios'
import { AbortError } from 'src/utils/errors.js'
import { getSettings_DEPRECATED } from 'src/utils/settings/settings.js'
import type { SearchResult, SearchOptions, WebSearchAdapter } from './types.js'

const DEFAULT_BASE_URL = 'http://100.121.247.3:8888'
const FETCH_TIMEOUT_MS = 30_000

interface OmniRouteSearchHit {
  title?: string
  url?: string
  snippet?: string
  content?: string
}

interface OmniRouteSearchResponse {
  results?: OmniRouteSearchHit[]
  data?: OmniRouteSearchHit[]
}

interface SettingsWithOmniRoute {
  omniRouteWebToolsBaseUrl?: string
  omniRouteWebToolsApiKey?: string
}

function getBaseUrl(): string {
  const settings = getSettings_DEPRECATED() as SettingsWithOmniRoute
  return (
    process.env.OMNIROUTE_WEB_TOOLS_BASE_URL ??
    settings.omniRouteWebToolsBaseUrl ??
    DEFAULT_BASE_URL
  )
}

function getApiKey(): string | undefined {
  const settings = getSettings_DEPRECATED() as SettingsWithOmniRoute
  return (
    process.env.OMNIROUTE_WEB_TOOLS_API_KEY ?? settings.omniRouteWebToolsApiKey
  )
}

function buildSearchUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/$/, '')
  return trimmed.endsWith('/v1/search') ? trimmed : `${trimmed}/v1/search`
}

export class OmnirouteSearchAdapter implements WebSearchAdapter {
  async search(query: string, options: SearchOptions): Promise<SearchResult[]> {
    const { signal, onProgress, allowedDomains, blockedDomains } = options

    if (signal?.aborted) {
      throw new AbortError()
    }

    onProgress?.({ type: 'query_update', query })

    const abortController = new AbortController()
    if (signal) {
      signal.addEventListener('abort', () => abortController.abort(), {
        once: true,
      })
    }

    const baseUrl = getBaseUrl()
    const searchUrl = buildSearchUrl(baseUrl)
    const apiKey = getApiKey()

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    }
    if (apiKey) {
      headers.Authorization = `Bearer ${apiKey}`
    }

    try {
      const response = await axios.post<OmniRouteSearchResponse>(
        searchUrl,
        {
          query,
          max_results: options.numResults ?? 8,
          search_type: options.searchType ?? 'auto',
          filters: {
            ...(allowedDomains?.length
              ? { include_domains: allowedDomains }
              : {}),
            ...(blockedDomains?.length
              ? { exclude_domains: blockedDomains }
              : {}),
          },
        },
        {
          signal: abortController.signal,
          timeout: FETCH_TIMEOUT_MS,
          headers,
          validateStatus: status => status >= 200 && status < 300,
        },
      )

      if (abortController.signal.aborted) {
        throw new AbortError()
      }

      const hits = response.data?.results ?? response.data?.data ?? []
      const results: SearchResult[] = []
      for (const hit of hits) {
        if (!hit.url) continue
        results.push({
          title: hit.title ?? hit.url,
          url: hit.url,
          snippet: hit.snippet ?? hit.content,
        })
      }

      onProgress?.({
        type: 'search_results_received',
        resultCount: results.length,
        query,
      })

      return results
    } catch (e) {
      if (axios.isCancel(e) || abortController.signal.aborted) {
        throw new AbortError()
      }
      throw e
    }
  }
}
