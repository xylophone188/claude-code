/**
 * GitHub Copilot translator — GitHub Copilot's /chat/completions endpoint is
 * OpenAI-compatible, but it requires a *Copilot* token (not the GitHub access
 * token). This module exchanges the GitHub access token for a short-lived
 * Copilot token (api.github.com/copilot_internal/v2/token) and caches it until
 * expiry, so claude-code's OpenAI-only race pool can use Copilot as a normal
 * OpenAI-compatible provider.
 *
 * Ported from 9router's github executor (executors/github.js refreshCopilotToken).
 */
const COPILOT_TOKEN_URL = 'https://api.github.com/copilot_internal/v2/token'

interface CopilotToken {
  token: string
  expiresAtMs: number
}

const tokenCache = new Map<string, CopilotToken>()

const DEFAULT_COPILOT_HEADERS = {
  'copilot-integration-id': 'vscode-chat',
  'editor-version': 'vscode/1.110.0',
  'editor-plugin-version': 'copilot-chat/0.38.0',
  'user-agent': 'GitHubCopilotChat/0.38.0',
  'openai-intent': 'conversation-panel',
  'x-github-api-version': '2025-04-01',
  'x-vscode-user-agent-library-version': 'electron-fetch',
  'X-Initiator': 'user',
  Accept: 'application/json',
  'Content-Type': 'application/json',
}

export interface RefreshOptions {
  accessToken: string
  headers?: Record<string, string>
  fetchImpl?: typeof fetch
}

/** Exchange a GitHub access token for a Copilot token. Throws on failure. */
export async function refreshCopilotToken(
  opts: RefreshOptions,
): Promise<CopilotToken> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const headers: Record<string, string> = {
    Authorization: `token ${opts.accessToken}`,
    ...DEFAULT_COPILOT_HEADERS,
    ...(opts.headers || {}),
  }
  const response = await fetchImpl(COPILOT_TOKEN_URL, {
    method: 'POST',
    headers,
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw Object.assign(
      new Error(
        `Copilot token refresh failed: ${response.status} ${text.slice(0, 300)}`,
      ),
      {
        status: response.status,
      },
    )
  }
  const data = (await response.json()) as {
    token: string
    expires_at?: number | string
  }
  if (!data.token) throw new Error('Copilot token refresh returned no token')
  const expiresAtMs =
    typeof data.expires_at === 'number'
      ? data.expires_at < 1e12
        ? data.expires_at * 1000
        : data.expires_at
      : data.expires_at
        ? new Date(data.expires_at).getTime()
        : Date.now() + 60 * 60 * 1000
  return { token: data.token, expiresAtMs }
}

/**
 * Return a valid Copilot token for the given GitHub access token, refreshing
 * (or re-resolving from cache) only when missing or within 5 minutes of expiry.
 */
export async function getCopilotToken(opts: RefreshOptions): Promise<string> {
  const cached = tokenCache.get(opts.accessToken)
  if (cached && cached.expiresAtMs - Date.now() > 5 * 60 * 1000) {
    return cached.token
  }
  const fresh = await refreshCopilotToken(opts)
  tokenCache.set(opts.accessToken, fresh)
  return fresh.token
}

/** Drop a cached Copilot token (e.g. on 401 to force re-refresh next call). */
export function invalidateCopilotToken(accessToken: string): void {
  tokenCache.delete(accessToken)
}
