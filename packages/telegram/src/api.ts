import type {
  GetUpdatesReq,
  SendChatActionReq,
  SendMessageReq,
  TelegramApiResponse,
  TelegramUpdate,
} from './types.js'
import {
  TelegramApiError,
  TelegramAuthError,
  TelegramConflictError,
} from './types.js'

const REQUEST_TIMEOUT_MS = 40_000
const LONG_POLL_TIMEOUT_S = 50

function buildUrl(baseUrl: string, token: string, method: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '')
  return `${trimmed}/bot${token}/${method}`
}

async function post<T>(
  baseUrl: string,
  token: string,
  method: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  if (signal) {
    signal.addEventListener('abort', () => controller.abort(), { once: true })
  }
  try {
    const response = await fetch(buildUrl(baseUrl, token, method), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    })

    const text = await response.text()
    let parsed: TelegramApiResponse<T>
    try {
      parsed = JSON.parse(text) as TelegramApiResponse<T>
    } catch {
      throw new TelegramApiError(
        response.status,
        `Non-JSON response: ${text.slice(0, 200)}`,
      )
    }

    if (!response.ok) {
      if (response.status === 401) {
        throw new TelegramAuthError(parsed.description ?? 'invalid token')
      }
      if (response.status === 409) {
        throw new TelegramConflictError(
          parsed.description ?? 'another consumer is polling',
        )
      }
      throw new TelegramApiError(
        response.status,
        parsed.description ?? response.statusText,
        parsed.parameters,
      )
    }

    if (!parsed.ok || parsed.result === undefined) {
      throw new TelegramApiError(
        response.status,
        parsed.description ?? 'missing result',
      )
    }

    return parsed.result
  } finally {
    clearTimeout(timeout)
  }
}

export async function getMe(
  baseUrl: string,
  token: string,
): Promise<{ id: number; username?: string }> {
  return post<{ id: number; username?: string }>(baseUrl, token, 'getMe', {})
}

export async function getUpdates(
  baseUrl: string,
  token: string,
  params: GetUpdatesReq,
  signal?: AbortSignal,
): Promise<TelegramUpdate[]> {
  return post<TelegramUpdate[]>(
    baseUrl,
    token,
    'getUpdates',
    {
      timeout: LONG_POLL_TIMEOUT_S,
      ...params,
    },
    signal,
  )
}

export async function sendMessage(
  baseUrl: string,
  token: string,
  params: SendMessageReq,
  signal?: AbortSignal,
): Promise<{ message_id: number }> {
  return post<{ message_id: number }>(
    baseUrl,
    token,
    'sendMessage',
    params as unknown as Record<string, unknown>,
    signal,
  )
}

export async function sendChatAction(
  baseUrl: string,
  token: string,
  params: SendChatActionReq,
  signal?: AbortSignal,
): Promise<true> {
  return post<true>(
    baseUrl,
    token,
    'sendChatAction',
    params as unknown as Record<string, unknown>,
    signal,
  )
}

export function retryAfterSeconds(error: unknown): number | null {
  if (error instanceof TelegramApiError && error.parameters?.retry_after) {
    return error.parameters.retry_after
  }
  return null
}
