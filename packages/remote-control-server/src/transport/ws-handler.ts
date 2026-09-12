import type { WSContext } from 'hono/ws'
import { getEventBus } from './event-bus'
import type { SessionEvent } from './event-bus'
import { publishSessionEvent } from '../services/transport'
import { touchSession } from '../services/session'
import { log, error as logError } from '../logger'
import { toClientPayload } from './client-payload'
import { config } from '../config'

// Per-connection cleanup, keyed by sessionId (only one WS per session)
interface CleanupEntry {
  unsub: () => void
  keepalive: ReturnType<typeof setInterval>
  ws: WSContext
  openTime: number
  lastClientActivity: number
}
const cleanupBySession = new Map<string, CleanupEntry>()

/**
 * Silence duration since the last client frame. Reads the mutable entry so
 * frames received via handleWebSocketMessage actually reset the timer —
 * a stale local snapshot at open time would close live connections.
 */
export function computeClientSilenceMs(
  entry: CleanupEntry | undefined,
  now = Date.now(),
): number {
  return now - (entry ? entry.lastClientActivity : now)
}

/**
 * Whether a connection has been silent too long to keep alive. Reads the
 * mutable entry (not a snapshot) so client frames reset the clock.
 */
export function isClientInactive(
  entry: CleanupEntry | undefined,
  now: number,
  timeoutMs: number,
): boolean {
  return computeClientSilenceMs(entry, now) > timeoutMs
}

// Track all active WS connections for graceful shutdown
const activeConnections = new Set<WSContext>()

// Server-side keepalive interval (configurable via RCS_WS_KEEPALIVE_INTERVAL).
// Sends data frames to keep reverse proxies from closing idle connections.
const SERVER_KEEPALIVE_INTERVAL_MS = (config.wsKeepaliveInterval || 20) * 1000

<<<<<<< Updated upstream
<<<<<<< Updated upstream
// Client-data silence before the server force-closes an idle WS.
// Independent of wsKeepaliveInterval — server keep_alive frames are
// server→client only and prove nothing about client liveness.
// Default 360s (3× the bridge client's 120s cadence) covers clients
// without keep_alive echo; with the echo fix this timer never fires.
const CLIENT_ACTIVITY_TIMEOUT_MS = (config.wsClientTimeout ?? 360) * 1000
=======
=======
>>>>>>> Stashed changes
// If no client data frame received within this threshold, the connection is
// considered dead. Deliberately independent of SERVER_KEEPALIVE_INTERVAL_MS —
// server keep_alive frames are server→client only and prove nothing about
// client liveness. Default 360s covers the bridge client's 120s keepalive
// cadence with margin; with the client echo fix this never fires anyway.
const CLIENT_ACTIVITY_TIMEOUT_MS = (config.wsClientTimeout || 360) * 1000

// Event types replayed on WS reconnect that the bridge child doesn't
// understand and logs as noise ("Ignoring unknown message type").
// Filtering by type (not direction) keeps inbound assistant history intact.
// NOT in this set: permission_response / control_response / interrupt —
// client-payload.ts converts them to real control messages the child
// consumes, so a response published while the socket was down must replay.
const REPLAY_IGNORED_TYPES = new Set([
  'session_status',
  'status',
  'keep_alive',
  'task_state',
  'automation_state',
])
<<<<<<< Updated upstream
>>>>>>> Stashed changes
=======
>>>>>>> Stashed changes

/**
 * Convert internal EventBus event -> SDK message for bridge client.
 */
function toSDKMessage(event: SessionEvent): string {
  // NDJSON format: each message MUST end with \n so the child process's
  // line-based parser can split messages correctly.
  return JSON.stringify(toClientPayload(event)) + '\n'
}

/** Called from onOpen — subscribes to event bus, forwards outbound events to bridge WS */
export function handleWebSocketOpen(ws: WSContext, sessionId: string) {
  const openTime = Date.now()
  const lastClientActivity = Date.now()
  log(`[RC-DEBUG] [WS] Open session=${sessionId}`)
  // A successful child connection is liveness evidence — reset the
  // disconnect monitor timer so an online session isn't marked inactive.
  touchSession(sessionId)
  activeConnections.add(ws)

  // If there's an existing connection for this session, clean it up first
  const existing = cleanupBySession.get(sessionId)
  if (existing) {
    log(`[WS] Replacing existing connection for session=${sessionId}`)
    existing.unsub()
    clearInterval(existing.keepalive)
    activeConnections.delete(existing.ws)
  }

  const bus = getEventBus(sessionId)

  // Replay ALL events (inbound + outbound) so the bridge can reconstruct
  // the full conversation history — assistant replies are inbound events.
  // Skip control/noise types the child doesn't understand.
  const missed = bus.getEventsSince(0)
  if (missed.length > 0) {
    log(`[WS] Replaying ${missed.length} missed event(s)`)
    for (const event of missed) {
      if (REPLAY_IGNORED_TYPES.has(event.type)) continue
      if (ws.readyState !== 1) break
      try {
        ws.send(toSDKMessage(event))
      } catch {
        // ignore send errors during replay
      }
    }
  }

  const unsub = bus.subscribe((event: SessionEvent) => {
    if (ws.readyState !== 1) return
    if (event.direction !== 'outbound') return
    try {
      const sdkMsg = toSDKMessage(event)
      log(
        `[RC-DEBUG] [WS] -> bridge (outbound): type=${event.type} len=${sdkMsg.length} msg=${sdkMsg.slice(0, 300)}`,
      )
      ws.send(sdkMsg)
    } catch (err) {
      logError('[RC-DEBUG] [WS] send error:', err)
    }
  })

  const keepalive = setInterval(() => {
    if (ws.readyState !== 1) {
      clearInterval(keepalive)
      return
    }
    // Read the mutable activity timestamp so client frames keep the
    // connection alive (handleWebSocketMessage updates entry.lastClientActivity).
    // Falls back to "now" when the entry is gone (close path clears the interval).
    const entry = cleanupBySession.get(sessionId)
    if (isClientInactive(entry, Date.now(), CLIENT_ACTIVITY_TIMEOUT_MS)) {
      const silenceMs = computeClientSilenceMs(entry)
      log(
        `[WS] Client inactive for ${Math.round(silenceMs / 1000)}s on session=${sessionId}, closing dead connection`,
      )
      try {
        ws.close(1000, 'client inactive')
      } catch {
        clearInterval(keepalive)
      }
      return
    }
    try {
      ws.send('{"type":"keep_alive"}\n')
    } catch {
      clearInterval(keepalive)
    }
  }, SERVER_KEEPALIVE_INTERVAL_MS)

  cleanupBySession.set(sessionId, {
    unsub,
    keepalive,
    ws,
    openTime,
    lastClientActivity,
  })
}

/**
 * Called from onMessage — bridge sends newline-delimited JSON.
 */
export function handleWebSocketMessage(
  ws: WSContext,
  sessionId: string,
  data: string,
) {
  // Track client activity for dead-connection detection
  const entry = cleanupBySession.get(sessionId)
  if (entry) {
    entry.lastClientActivity = Date.now()
  }
  // Refresh session liveness per frame (not per line) so the disconnect
  // monitor doesn't mark an actively-communicating session inactive.
  touchSession(sessionId)
  const lines = data.split('\n').filter(l => l.trim())
  for (const line of lines) {
    try {
      ingestBridgeMessage(sessionId, JSON.parse(line))
    } catch (err) {
      logError('[WS] parse error:', err)
    }
  }
}

/** Called from onClose — unsubscribes from event bus */
export function handleWebSocketClose(
  ws: WSContext,
  sessionId: string,
  code?: number,
  reason?: string,
) {
  activeConnections.delete(ws)

  const entry = cleanupBySession.get(sessionId)
  // Only tear down if this socket is still the tracked connection. A delayed
  // close from a superseded socket (replaced by a reconnect) must not strip
  // the replacement's subscription/keepalive.
  const isCurrent = entry !== undefined && entry.ws === ws
  const duration = isCurrent
    ? Math.round((Date.now() - entry.openTime) / 1000)
    : -1

  log(
    `[WS] Close session=${sessionId} code=${code ?? 'none'} reason=${reason || '(none)'} duration=${duration}s${isCurrent ? '' : ' (superseded)'}`,
  )

  if (isCurrent) {
    entry.unsub()
    clearInterval(entry.keepalive)
    cleanupBySession.delete(sessionId)
  }
}

/**
 * Derive event type from a child process message that may lack an explicit
 * `type` field. The child's --print --output-format stream-json mode sends:
 *   {"message":{"role":"user",...},"uuid":"..."}       → type "user"
 *   {"message":{"role":"assistant",...},"uuid":"..."}  → type "assistant"
 *   {"subtype":"success","uuid":"...","result":"..."}  → type "result"
 */
function deriveEventType(msg: Record<string, unknown>): string {
  if (msg.type && typeof msg.type === 'string') return msg.type

  // Child process stream-json format: message.role determines type
  const message = msg.message as Record<string, unknown> | undefined
  if (message && typeof message.role === 'string') {
    return message.role // "user", "assistant", "system"
  }

  // Result message
  if (msg.subtype || msg.result !== undefined) return 'result'

  // System/init message
  if (msg.session_id) return 'system'

  return 'unknown'
}

/**
 * Parse a single SDK message from bridge -> publish to EventBus as inbound.
 */
export function ingestBridgeMessage(
  sessionId: string,
  msg: Record<string, unknown>,
) {
  if (msg.type === 'keep_alive') return

  const eventType = deriveEventType(msg)

  log(
    `[RC-DEBUG] [WS] <- bridge (inbound): sessionId=${sessionId} type=${eventType}${msg.uuid ? ` uuid=${msg.uuid}` : ''} msg=${JSON.stringify(msg).slice(0, 300)}`,
  )

  let payload: unknown

  if (eventType === 'assistant' || eventType === 'partial_assistant') {
    const message = msg.message as Record<string, unknown> | undefined
    const content = message?.content
    // Extract text from content blocks for simple display
    let text = ''
    if (typeof content === 'string') {
      text = content
    } else if (Array.isArray(content)) {
      text = content
        .filter(
          (b: unknown) =>
            b &&
            typeof b === 'object' &&
            'type' in (b as Record<string, unknown>) &&
            (b as Record<string, unknown>).type === 'text',
        )
        .map(
          (b: Record<string, unknown>) =>
            (b as Record<string, unknown>).text || '',
        )
        .join('')
    }
    payload = { message: msg.message, uuid: msg.uuid, content: text }
  } else if (eventType === 'user' || eventType === 'system') {
    payload = {
      message: msg.message,
      uuid: msg.uuid,
      ...(typeof msg.isSynthetic === 'boolean'
        ? { isSynthetic: msg.isSynthetic }
        : {}),
    }
  } else if (eventType === 'control_request') {
    payload = { request_id: msg.request_id, request: msg.request }
  } else if (eventType === 'control_response') {
    payload = { response: msg.response }
  } else if (eventType === 'result' || eventType === 'result_success') {
    payload = { subtype: msg.subtype, uuid: msg.uuid, result: msg.result }
  } else {
    payload = msg
  }

  publishSessionEvent(sessionId, eventType, payload, 'inbound')
}

/**
 * Gracefully close all active WebSocket connections.
 */
export function closeAllConnections(): void {
  const count = activeConnections.size
  if (count === 0) return

  log(`[WS] Gracefully closing ${count} active connection(s)...`)
  for (const [sessionId, entry] of cleanupBySession) {
    try {
      entry.unsub()
      clearInterval(entry.keepalive)
      if (entry.ws.readyState === 1) {
        entry.ws.close(1001, 'server_shutdown')
      }
    } catch {
      // ignore errors during shutdown
    }
  }
  cleanupBySession.clear()
  activeConnections.clear()
  log('[WS] All connections closed')
}
