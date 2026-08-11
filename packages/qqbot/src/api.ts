import { randomUUID } from 'node:crypto'
import {
  DEFAULT_APP_ACCESS_TOKEN_URL,
  DEFAULT_API_BASE,
  type AccountData,
} from './accounts.js'
import type {
  C2CSendBody,
  C2CSendResp,
  GetAppAccessTokenResp,
} from './types.js'

export const CHANNEL_VERSION = '0.1.0'

async function getAppAccessToken(
  appId: string,
  clientSecret: string,
): Promise<string> {
  const response = await fetch(DEFAULT_APP_ACCESS_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: appId, client_secret: clientSecret }),
  })

  if (!response.ok) {
    throw new Error(`Failed to get app access token: HTTP ${response.status}`)
  }

  const data = (await response.json()) as GetAppAccessTokenResp
  if (!data.access_token) {
    throw new Error('No access_token in response')
  }

  return data.access_token
}

async function post<T>(
  baseUrl: string,
  path: string,
  body: unknown,
  token?: string,
  timeoutMs = 40_000,
  signal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  if (signal) {
    signal.addEventListener('abort', () => controller.abort(), { once: true })
  }

  try {
    const response = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `QQBot ${token}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    }

    return (await response.json()) as T
  } finally {
    clearTimeout(timeout)
  }
}

export async function getC2CMessageId(): Promise<string> {
  return randomUUID()
}

export async function sendC2CMessage(
  params: {
    to: string
    text: string
    baseUrl: string
    token: string
    messageId?: string
    seq?: number
  },
  signal?: AbortSignal,
): Promise<C2CSendResp> {
  const { to, text, baseUrl, token, messageId, seq } = params

  const body: C2CSendBody = {
    msg_type: 0,
    content: text,
    msg_seq: seq ?? 1,
    msg_id: messageId ?? randomUUID(),
  }

  return post<C2CSendResp>(
    baseUrl,
    `/v2/users/${to}/messages`,
    body,
    token,
    40_000,
    signal,
  )
}

export async function getAppAccessTokenWithRetry(
  account: AccountData,
  signal?: AbortSignal,
): Promise<string> {
  const maxRetries = 3
  let lastError: Error | undefined

  for (let i = 0; i < maxRetries; i++) {
    try {
      return await getAppAccessToken(account.appId, account.clientSecret)
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error))
      if (i === maxRetries - 1) {
        throw lastError
      }
      await new Promise(resolve => setTimeout(resolve, 1000 * (i + 1)))
    }
  }

  throw lastError ?? new Error('Failed to get app access token')
}
