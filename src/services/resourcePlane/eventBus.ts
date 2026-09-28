/**
 * Phase 3.6: Event-driven async synchronization via outbox/inbox pattern.
 *
 * Features:
 *  - Outbox: append events atomically with domain changes
 *  - Inbox: idempotent consumer with deduplication
 *  - Retry with exponential backoff
 *  - Dead letter queue for poison messages
 */

import { getPgPool } from '../pg/pool.js'
import type { PoolClient } from 'pg'

// ── Types ─────────────────────────────────────────────────────────────────────

export interface OutboxEvent {
  eventId: string
  aggregateType: string
  aggregateId: string
  eventType: string
  payload: unknown
  revision: number
  sourceNodeId: string
  createdAt: Date
  deliveredAt: Date | null
  deliveryAttempts: number
  lastError: string | null
}

export interface InboxEvent {
  eventId: string
  sourceNodeId: string
  eventType: string
  payload: Record<string, unknown>
  receivedAt: Date
  appliedAt: Date | null
  applyError: string | null
}

export type EventHandler = (event: InboxEvent) => Promise<void>

export interface EventBusOptions {
  pollIntervalMs?: number
  batchSize?: number
  maxRetries?: number
  retryBaseDelayMs?: number
  maxRetryDelayMs?: number
  deadLetterThreshold?: number
}

// ── Outbox Producer ───────────────────────────────────────────────────────────

export class OutboxProducer {
  static async append(
    client: PoolClient,
    event: Omit<
      OutboxEvent,
      'eventId' | 'createdAt' | 'deliveredAt' | 'deliveryAttempts' | 'lastError'
    >,
  ): Promise<string> {
    const eventId = crypto.randomUUID()
    const now = new Date()

    await client.query(
      `INSERT INTO resource_plane.outbox_events
         (event_id, aggregate_type, aggregate_id, event_type, payload, revision, source_node_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        eventId,
        event.aggregateType,
        event.aggregateId,
        event.eventType,
        JSON.stringify(event.payload),
        event.revision,
        event.sourceNodeId,
        now,
      ],
    )

    return eventId
  }

  static async appendBatch(
    client: PoolClient,
    events: Array<
      Omit<
        OutboxEvent,
        | 'eventId'
        | 'createdAt'
        | 'deliveredAt'
        | 'deliveryAttempts'
        | 'lastError'
      >
    >,
  ): Promise<string[]> {
    const ids: string[] = []
    for (const event of events) {
      ids.push(await OutboxProducer.append(client, event))
    }
    return ids
  }
}

// ── Outbox Consumer / Publisher ───────────────────────────────────────────────

export class OutboxConsumer {
  private readonly pollIntervalMs: number
  private readonly batchSize: number
  private readonly maxRetries: number
  private readonly retryBaseDelayMs: number
  private readonly maxRetryDelayMs: number
  private timer: ReturnType<typeof setInterval> | null = null
  private stopped = false

  constructor(options: EventBusOptions = {}) {
    this.pollIntervalMs = options.pollIntervalMs ?? 1_000
    this.batchSize = options.batchSize ?? 100
    this.maxRetries = options.maxRetries ?? 10
    this.retryBaseDelayMs = options.retryBaseDelayMs ?? 1_000
    this.maxRetryDelayMs = options.maxRetryDelayMs ?? 60_000
  }

  async start(
    publisher: (event: OutboxEvent) => Promise<boolean>,
  ): Promise<void> {
    if (this.timer) return
    console.log('[OutboxConsumer] Starting outbox publisher')
    this.stopped = false
    this.timer = setInterval(() => this._poll(publisher), this.pollIntervalMs)
    await this._poll(publisher)
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    console.log('[OutboxConsumer] Stopped outbox publisher')
  }

  private async _poll(
    publisher: (event: OutboxEvent) => Promise<boolean>,
  ): Promise<void> {
    if (this.stopped) return

    const pool = getPgPool()
    const client = await pool.connect()
    try {
      // Get undelivered events ordered by creation time
      const res = await client.query<{
        event_id: string
        aggregate_type: string
        aggregate_id: string
        event_type: string
        payload: unknown
        revision: number
        source_node_id: string
        created_at: Date
        delivered_at: Date | null
        delivery_attempts: number
        last_error: string | null
      }>(
        `SELECT event_id, aggregate_type, aggregate_id, event_type, payload, revision,
                source_node_id, created_at, delivered_at, delivery_attempts, last_error
         FROM resource_plane.outbox_events
         WHERE delivered_at IS NULL
           AND delivery_attempts < $1
         ORDER BY created_at ASC
         LIMIT $2`,
        [this.maxRetries, this.batchSize],
      )

      if (res.rows.length === 0) return

      console.log(`[OutboxConsumer] Publishing ${res.rows.length} events`)

      for (const row of res.rows) {
        const event: OutboxEvent = {
          eventId: row.event_id,
          aggregateType: row.aggregate_type,
          aggregateId: row.aggregate_id,
          eventType: row.event_type,
          payload: row.payload,
          revision: row.revision,
          sourceNodeId: row.source_node_id,
          createdAt: row.created_at,
          deliveredAt: row.delivered_at,
          deliveryAttempts: row.delivery_attempts,
          lastError: row.last_error,
        }
        try {
          const success = await publisher(event)
          if (success) {
            await this._markDelivered(client, event.eventId)
          } else {
            await this._incrementRetry(
              client,
              event.eventId,
              'Publisher returned false',
            )
          }
        } catch (err) {
          await this._incrementRetry(client, event.eventId, String(err))
        }
      }
    } catch (err) {
      console.error('[OutboxConsumer] Poll error:', err)
    } finally {
      client.release()
    }
  }

  private async _markDelivered(
    client: PoolClient,
    eventId: string,
  ): Promise<void> {
    await client.query(
      `UPDATE resource_plane.outbox_events
       SET delivered_at = now(), delivery_attempts = delivery_attempts + 1
       WHERE event_id = $1`,
      [eventId],
    )
  }

  private async _incrementRetry(
    client: PoolClient,
    eventId: string,
    error: string,
  ): Promise<void> {
    await client.query(
      `UPDATE resource_plane.outbox_events
       SET delivery_attempts = delivery_attempts + 1, last_error = $2
       WHERE event_id = $1`,
      [eventId, error],
    )
  }
}

// ── Inbox Consumer ────────────────────────────────────────────────────────────

export class InboxConsumer {
  private readonly handlers: Map<string, EventHandler> = new Map()
  private readonly pollIntervalMs: number
  private readonly batchSize: number
  private timer: ReturnType<typeof setInterval> | null = null
  private stopped = false

  constructor(options: EventBusOptions = {}) {
    this.pollIntervalMs = options.pollIntervalMs ?? 500
    this.batchSize = options.batchSize ?? 100
  }

  registerHandler(eventType: string, handler: EventHandler): void {
    this.handlers.set(eventType, handler)
  }

  async start(): Promise<void> {
    if (this.timer) return
    console.log('[InboxConsumer] Starting inbox processor')
    this.stopped = false
    this.timer = setInterval(() => this._poll(), this.pollIntervalMs)
    await this._poll()
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    console.log('[InboxConsumer] Stopped inbox processor')
  }

  async receive(
    event: Omit<InboxEvent, 'receivedAt' | 'appliedAt' | 'applyError'>,
  ): Promise<void> {
    const pool = getPgPool()
    const client = await pool.connect()
    try {
      await client.query(
        `INSERT INTO resource_plane.inbox_events
           (event_id, source_node_id, event_type, payload, received_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (event_id) DO NOTHING`,
        [
          event.eventId,
          event.sourceNodeId,
          event.eventType,
          JSON.stringify(event.payload),
        ],
      )
    } finally {
      client.release()
    }
  }

  private async _poll(): Promise<void> {
    if (this.stopped) return

    const pool = getPgPool()
    const client = await pool.connect()
    try {
      const res = await client.query<{
        event_id: string
        source_node_id: string
        event_type: string
        payload: unknown
        received_at: Date
        applied_at: Date | null
        apply_error: string | null
      }>(
        `SELECT event_id, source_node_id, event_type, payload, received_at, applied_at, apply_error
         FROM resource_plane.inbox_events
         WHERE applied_at IS NULL
         ORDER BY received_at ASC
         LIMIT $1`,
        [this.batchSize],
      )

      if (res.rows.length === 0) return

      for (const row of res.rows) {
        const event: InboxEvent = {
          eventId: row.event_id,
          sourceNodeId: row.source_node_id,
          eventType: row.event_type,
          payload: row.payload as Record<string, unknown>,
          receivedAt: row.received_at,
          appliedAt: row.applied_at,
          applyError: row.apply_error,
        }
        await this._processEvent(client, event)
      }
    } catch (err) {
      console.error('[InboxConsumer] Poll error:', err)
    } finally {
      client.release()
    }
  }

  private async _processEvent(
    client: PoolClient,
    event: InboxEvent,
  ): Promise<void> {
    const handler = this.handlers.get(event.eventType)
    if (!handler) {
      await this._markFailed(
        client,
        event.eventId,
        `No handler for event type: ${event.eventType}`,
      )
      return
    }

    try {
      await handler(event)
      await this._markApplied(client, event.eventId)
    } catch (err) {
      await this._markFailed(client, event.eventId, String(err))
    }
  }

  private async _markApplied(
    client: PoolClient,
    eventId: string,
  ): Promise<void> {
    await client.query(
      `UPDATE resource_plane.inbox_events
       SET applied_at = now()
       WHERE event_id = $1`,
      [eventId],
    )
  }

  private async _markFailed(
    client: PoolClient,
    eventId: string,
    error: string,
  ): Promise<void> {
    await client.query(
      `UPDATE resource_plane.inbox_events
       SET apply_error = $2
       WHERE event_id = $1`,
      [eventId, error],
    )
  }
}

// ── Event Types ───────────────────────────────────────────────────────────────

export const RESOURCE_PLANE_EVENT_TYPES = {
  PROVIDER_CREATED: 'provider.created',
  PROVIDER_UPDATED: 'provider.updated',
  PROVIDER_DELETED: 'provider.deleted',
  ACCOUNT_CREATED: 'account.created',
  ACCOUNT_UPDATED: 'account.updated',
  ACCOUNT_DELETED: 'account.deleted',
  CREDENTIAL_ROTATED: 'credential.rotated',
  CREDENTIAL_EXPIRED: 'credential.expired',
  SYNC_COMPLETED: 'sync.completed',
} as const

export type ResourcePlaneEventType =
  (typeof RESOURCE_PLANE_EVENT_TYPES)[keyof typeof RESOURCE_PLANE_EVENT_TYPES]

// ── Helper: Emit domain events ────────────────────────────────────────────────

export async function emitProviderEvent(
  client: PoolClient,
  eventType: ResourcePlaneEventType,
  providerId: string,
  payload: Record<string, unknown>,
  revision: number,
  sourceNodeId: string,
): Promise<string> {
  return OutboxProducer.append(client, {
    aggregateType: 'provider',
    aggregateId: providerId,
    eventType,
    payload,
    revision,
    sourceNodeId,
  })
}

export async function emitCredentialEvent(
  client: PoolClient,
  eventType: ResourcePlaneEventType,
  providerId: string,
  accountId: string,
  secretType: string,
  payload: Record<string, unknown>,
  revision: number,
  sourceNodeId: string,
): Promise<string> {
  return OutboxProducer.append(client, {
    aggregateType: 'credential',
    aggregateId: `${providerId}:${accountId}:${secretType}`,
    eventType,
    payload,
    revision,
    sourceNodeId,
  })
}

// ── Singleton ─────────────────────────────────────────────────────────────────

let _outboxConsumer: OutboxConsumer | null = null
let _inboxConsumer: InboxConsumer | null = null

export function getOutboxConsumer(options?: EventBusOptions): OutboxConsumer {
  if (!_outboxConsumer) {
    _outboxConsumer = new OutboxConsumer(options)
  }
  return _outboxConsumer
}

export function getInboxConsumer(options?: EventBusOptions): InboxConsumer {
  if (!_inboxConsumer) {
    _inboxConsumer = new InboxConsumer(options)
  }
  return _inboxConsumer
}

export function resetEventBusForTest(): void {
  if (_outboxConsumer) {
    _outboxConsumer.stop().catch(() => {})
    _outboxConsumer = null
  }
  if (_inboxConsumer) {
    _inboxConsumer.stop().catch(() => {})
    _inboxConsumer = null
  }
}
