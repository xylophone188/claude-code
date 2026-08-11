import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getUpdates, retryAfterSeconds, sendChatAction } from './api.js'
import { DEFAULT_API_BASE, getStateDir } from './accounts.js'
import { addPendingPairing, isAllowed } from './pairing.js'
import {
  consumePendingPermission,
  setActivePermissionChat,
} from './permissions.js'
import { sendText } from './send.js'
import { TelegramAuthError, TelegramConflictError } from './types.js'
import type { TelegramChat, TelegramMessage, TelegramUpdate } from './types.js'

// Canonical permission reply regex (matches weixin/qqbot).
const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i

export interface ParsedMessage {
  fromUserId: string
  chatId: string
  messageId: number
  text: string
  username?: string
}

export type OnMessageCallback = (msg: ParsedMessage) => Promise<void>

export interface PermissionResponse {
  requestId: string
  behavior: 'allow' | 'deny'
  fromUserId: string
}

export type OnPermissionResponseCallback = (
  response: PermissionResponse,
) => Promise<void>

export function extractPermissionReply(
  text: string,
): { requestId: string; behavior: 'allow' | 'deny' } | null {
  const match = text.match(PERMISSION_REPLY_RE)
  if (!match) return null
  const behavior = match[1]!.toLowerCase().startsWith('y') ? 'allow' : 'deny'
  const requestId = match[2]!.toLowerCase()
  return { requestId, behavior }
}

function cursorPath(): string {
  return join(getStateDir(), 'cursor.txt')
}

function loadCursor(): number {
  const path = cursorPath()
  if (!existsSync(path)) return 0
  const raw = readFileSync(path, 'utf-8').trim()
  const n = Number(raw)
  return Number.isFinite(n) ? n : 0
}

function saveCursor(offset: number): void {
  writeFileSync(cursorPath(), String(offset), 'utf-8')
}

function identifierForChat(
  chat: TelegramChat,
  from?: { id?: number; username?: string },
): string {
  if (from?.username) return `@${from.username}`
  return String(chat.id)
}

async function processUpdate(
  update: TelegramUpdate,
  ctx: {
    baseUrl: string
    token: string
    onMessage: OnMessageCallback
    onPermissionResponse?: OnPermissionResponseCallback
  },
): Promise<void> {
  const message: TelegramMessage | undefined =
    update.message ?? update.edited_message ?? update.channel_post
  if (!message) return
  if (!message.text) return

  const identifier = identifierForChat(message.chat, message.from)
  const text = message.text

  if (ctx.onPermissionResponse) {
    const reply = extractPermissionReply(text)
    if (reply) {
      const pending = consumePendingPermission(reply.requestId, identifier)
      if (pending) {
        await ctx.onPermissionResponse({
          requestId: pending.request_id,
          behavior: reply.behavior,
          fromUserId: identifier,
        })
        return
      }
    }
  }

  if (!isAllowed(identifier)) {
    const code = addPendingPairing(identifier)
    try {
      await sendText({
        to: String(message.chat.id),
        text: `Your pairing code is: ${code}\n\nAsk the operator to confirm:\nccb telegram access pair ${code}`,
        baseUrl: ctx.baseUrl,
        token: ctx.token,
        replyToMessageId: message.message_id,
      })
    } catch (error) {
      process.stderr.write(`[telegram] Failed to send pairing code: ${error}\n`)
    }
    return
  }

  setActivePermissionChat(identifier)

  await ctx.onMessage({
    fromUserId: identifier,
    chatId: String(message.chat.id),
    messageId: message.message_id,
    text,
    username: message.from?.username,
  })
}

export interface StartPollLoopParams {
  baseUrl: string
  token: string
  onMessage: OnMessageCallback
  onPermissionResponse?: OnPermissionResponseCallback
  abortSignal: AbortSignal
}

/**
 * Long-poll loop for Telegram Bot API. Persists offset across restarts and
 * honors 429 Retry-After. Returns only on abort.
 */
export async function startPollLoop(
  params: StartPollLoopParams,
): Promise<void> {
  const { baseUrl, token, onMessage, onPermissionResponse, abortSignal } =
    params
  const apiBase = baseUrl || DEFAULT_API_BASE
  let offset = loadCursor()
  let consecutiveErrors = 0

  process.stderr.write('[telegram] Starting poll loop...\n')

  while (!abortSignal.aborted) {
    try {
      const updates = await getUpdates(
        apiBase,
        token,
        {
          offset: offset > 0 ? offset : undefined,
          limit: 100,
          allowed_updates: ['message', 'edited_message', 'channel_post'],
        },
        abortSignal,
      )
      consecutiveErrors = 0

      if (updates.length === 0) continue

      for (const update of updates) {
        if (abortSignal.aborted) break
        try {
          await processUpdate(update, {
            baseUrl: apiBase,
            token,
            onMessage,
            onPermissionResponse,
          })
        } catch (error) {
          process.stderr.write(
            `[telegram] Failed to process update ${update.update_id}: ${error}\n`,
          )
        }
        offset = Math.max(offset, update.update_id + 1)
      }
      saveCursor(offset)
    } catch (error) {
      if (abortSignal.aborted) break

      if (error instanceof TelegramAuthError) {
        process.stderr.write(
          `[telegram] Auth error, aborting: ${error.message}\n`,
        )
        throw error
      }
      if (error instanceof TelegramConflictError) {
        // Another consumer is polling — surface and stop.
        process.stderr.write(
          `[telegram] Conflict (409) — another bot consumer is polling. Aborting.\n`,
        )
        throw error
      }

      if (!(error instanceof Error)) {
        process.stderr.write(
          `[telegram] Unexpected error type: ${String(error)}\n`,
        )
        throw error
      }

      const retryAfter = retryAfterSeconds(error)
      if (retryAfter !== null) {
        process.stderr.write(
          `[telegram] Rate limited, sleeping ${retryAfter}s...\n`,
        )
        await new Promise(resolve => setTimeout(resolve, retryAfter * 1000))
        continue
      }

      consecutiveErrors += 1
      process.stderr.write(
        `[telegram] Poll error (${consecutiveErrors}): ${error instanceof Error ? error.message : String(error)}\n`,
      )
      const backoff = Math.min(
        60_000,
        1000 * 2 ** Math.min(consecutiveErrors, 6),
      )
      await new Promise(resolve => setTimeout(resolve, backoff))
    }
  }

  process.stderr.write('[telegram] Poll loop stopped.\n')
}

/** Public so the MCP server can send real typing indicators. */
export async function sendTypingIndicator(params: {
  chatId: string
  baseUrl: string
  token: string
  signal?: AbortSignal
}): Promise<void> {
  await sendChatAction(
    params.baseUrl,
    params.token,
    {
      chat_id: Number(params.chatId),
      action: 'typing',
    },
    params.signal,
  )
}
