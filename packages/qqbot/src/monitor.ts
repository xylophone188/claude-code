import WebSocket from 'ws'
import { DEFAULT_API_BASE, getStateDir } from './accounts.js'
import { sendText } from './send.js'
import { addPendingPairing, isAllowed } from './pairing.js'
import {
  consumePendingPermission,
  setActivePermissionChat,
} from './permissions.js'

const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i

export interface ParsedMessage {
  fromUserId: string
  messageId: string
  text: string
  attachmentPath?: string
  attachmentType?: string
}

export type OnMessageCallback = (msg: ParsedMessage) => Promise<void>

export type PermissionResponse = {
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
  const behavior = match[1]?.toLowerCase().startsWith('y') ? 'allow' : 'deny'
  const requestId = match[2]?.toLowerCase()
  if (!requestId) return null
  return { requestId, behavior }
}

interface GatewayMessage {
  op: number
  d?: unknown
  s?: number
  t?: string
}

interface GatewayHelloData {
  heartbeat_interval?: number
}

interface C2CMessageDispatch {
  content?: string
  author?: { user_openid?: string; id?: string; bot?: boolean }
  direct_message?: boolean
  msg_id?: string
  id?: string
  event_id?: string
}

function isGatewayMessage(data: unknown): data is GatewayMessage {
  if (typeof data !== 'object' || data === null) return false
  const msg = data as Record<string, unknown>
  return typeof msg.op === 'number'
}

export async function startPollLoop(params: {
  baseUrl: string
  token: string
  onMessage: OnMessageCallback
  onPermissionResponse?: OnPermissionResponseCallback
  abortSignal: AbortSignal
}): Promise<void> {
  const { baseUrl, token, onMessage, onPermissionResponse, abortSignal } =
    params

  process.stderr.write('[qqbot] Connecting to QQ gateway...\n')

  const wsUrl =
    baseUrl && baseUrl !== DEFAULT_API_BASE
      ? baseUrl
      : 'wss://api.sgroup.qq.com/websocket'

  let heartbeatTimer: ReturnType<typeof setInterval> | null = null
  let lastSequence = 0
  let sessionId = ''
  let shouldResume = false

  const socket = new WebSocket(wsUrl, { maxPayload: 1024 * 1024 * 16 })

  socket.on('open', () => {
    process.stderr.write('[qqbot] Gateway connected.\n')
  })

  socket.on('message', async data => {
    let parsed: unknown
    try {
      parsed = JSON.parse(data.toString())
    } catch {
      return
    }

    if (!isGatewayMessage(parsed)) return
    const msg = parsed

    if (msg.s) {
      lastSequence = msg.s
    }

    switch (msg.op) {
      case 10: {
        const hello = msg.d as GatewayHelloData
        const interval = hello.heartbeat_interval || 30_000
        const identify = shouldResume
          ? {
              op: 6,
              d: {
                token: `QQBot ${token}`,
                session_id: sessionId,
                seq: lastSequence,
              },
            }
          : {
              op: 2,
              d: {
                token: `QQBot ${token}`,
                intents: (1 << 25) | (1 << 30) | (1 << 12) | (1 << 26),
                shard: [0, 1],
              },
            }
        socket.send(JSON.stringify(identify))
        if (heartbeatTimer) clearInterval(heartbeatTimer)
        heartbeatTimer = setInterval(() => {
          socket.send(JSON.stringify({ op: 1, d: lastSequence }))
        }, interval)
        break
      }
      case 0: {
        if (msg.t === 'READY' && msg.d) {
          const ready = msg.d as {
            user?: { id?: string }
            session_id?: string
          }
          sessionId = ready.session_id || ''
          process.stderr.write('[qqbot] Gateway READY.\n')
        }
        if (msg.t === 'C2C_MESSAGE_CREATE' && msg.d) {
          await handleDispatch(msg.d as C2CMessageDispatch, {
            baseUrl,
            token,
            onMessage,
            onPermissionResponse,
          })
        }
        break
      }
      case 7: {
        process.stderr.write('[qqbot] RECONNECT requested, reconnecting...\n')
        shouldResume = true
        socket.close()
        break
      }
      case 9: {
        process.stderr.write('[qqbot] Invalid session, re-identifying...\n')
        shouldResume = false
        const identify = {
          op: 2,
          d: {
            token: `QQBot ${token}`,
            intents: (1 << 25) | (1 << 30) | (1 << 12) | (1 << 26),
            shard: [0, 1],
          },
        }
        socket.send(JSON.stringify(identify))
        break
      }
      default:
        break
    }
  })

  socket.on('close', () => {
    process.stderr.write('[qqbot] Gateway closed.\n')
    if (heartbeatTimer) clearInterval(heartbeatTimer)
  })

  socket.on('error', error => {
    process.stderr.write(`[qqbot] Gateway error: ${error.message}\n`)
  })

  await new Promise<void>(resolve => {
    abortSignal.addEventListener(
      'abort',
      () => {
        socket.close()
        if (heartbeatTimer) clearInterval(heartbeatTimer)
        resolve()
      },
      { once: true },
    )
  })

  process.stderr.write('[qqbot] Poll loop stopped.\n')
}

async function handleDispatch(
  dispatch: C2CMessageDispatch,
  ctx: {
    baseUrl: string
    token: string
    onMessage: OnMessageCallback
    onPermissionResponse?: OnPermissionResponseCallback
  },
): Promise<void> {
  const fromUserId = dispatch.author?.user_openid || dispatch.author?.id || ''
  if (!fromUserId || dispatch.author?.bot === true) return

  const textContent = dispatch.content || ''
  if (!textContent) return

  if (textContent && ctx.onPermissionResponse) {
    const permissionReply = extractPermissionReply(textContent)
    if (permissionReply) {
      const pending = consumePendingPermission(
        permissionReply.requestId,
        fromUserId,
      )
      if (pending) {
        await ctx.onPermissionResponse({
          requestId: pending.request_id,
          behavior: permissionReply.behavior,
          fromUserId,
        })
        return
      }
    }
  }

  if (!isAllowed(fromUserId)) {
    const code = addPendingPairing(fromUserId)
    try {
      await sendText({
        to: fromUserId,
        text: `Your pairing code is: ${code}\n\nAsk the operator to confirm:\nccb qqbot access pair ${code}`,
        baseUrl: ctx.baseUrl,
        token: ctx.token,
      })
    } catch (error) {
      process.stderr.write(`[qqbot] Failed to send pairing code: ${error}\n`)
    }
    return
  }

  setActivePermissionChat(fromUserId)

  await ctx.onMessage({
    fromUserId,
    messageId: dispatch.msg_id || dispatch.id || dispatch.event_id || '',
    text: textContent,
  })
}
