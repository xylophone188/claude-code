import { describe, test, expect, mock } from 'bun:test'
import {
  refreshCopilotToken,
  getCopilotToken,
  invalidateCopilotToken,
} from '../github.js'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('refreshCopilotToken', () => {
  test('exchanges a GitHub access token for a Copilot token', async () => {
    const fetchImpl = mock((_url: string, _init: unknown) =>
      Promise.resolve(
        jsonResponse({
          token: 'copilot-abc',
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        }),
      ),
    ) as unknown as typeof fetch
    const token = await refreshCopilotToken({
      accessToken: 'gh-token',
      fetchImpl,
    })
    expect(token.token).toBe('copilot-abc')
    expect(token.expiresAtMs).toBeGreaterThan(Date.now())
  })

  test('throws on a non-200 refresh', async () => {
    const fetchImpl = mock(() =>
      Promise.resolve(jsonResponse({ message: 'bad' }, 401)),
    ) as unknown as typeof fetch
    await expect(
      refreshCopilotToken({ accessToken: 'gh-token', fetchImpl }),
    ).rejects.toThrow(/Copilot token refresh failed/)
  })
})

describe('getCopilotToken', () => {
  test('caches the token across calls (single refresh)', async () => {
    let calls = 0
    const fetchImpl = mock((_url: string, _init: unknown) => {
      calls++
      return Promise.resolve(
        jsonResponse({
          token: 'copilot-cached',
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        }),
      )
    }) as unknown as typeof fetch
    const opts = { accessToken: 'gh-token-2', fetchImpl }
    const first = await getCopilotToken(opts)
    const second = await getCopilotToken(opts)
    expect(first).toBe('copilot-cached')
    expect(second).toBe('copilot-cached')
    expect(calls).toBe(1)
  })

  test('re-refreshes after invalidation', async () => {
    let calls = 0
    const fetchImpl = mock(() => {
      calls++
      return Promise.resolve(
        jsonResponse({
          token: `copilot-${calls}`,
          expires_at: Math.floor(Date.now() / 1000) + 3600,
        }),
      )
    }) as unknown as typeof fetch
    const opts = { accessToken: 'gh-token-3', fetchImpl }
    await getCopilotToken(opts)
    invalidateCopilotToken('gh-token-3')
    const after = await getCopilotToken(opts)
    expect(after).toBe('copilot-2')
    expect(calls).toBe(2)
  })
})
