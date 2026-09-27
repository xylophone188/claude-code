import { beforeEach, describe, expect, test } from 'bun:test'
import {
  OutboxProducer,
  OutboxConsumer,
  InboxConsumer,
  resetEventBusForTest,
  emitProviderEvent,
  emitCredentialEvent,
  RESOURCE_PLANE_EVENT_TYPES,
} from '../eventBus.js'
import { getPgPool } from '../../pg/pool.js'

describe('Phase 3.6: Event-driven synchronization', () => {
  const ENV_KEY = 'CCB_RESOURCE_PLANE'
  const KEY_ENV = 'CCB_RESOURCE_PLANE_KEY'
  const ORIG_ENV = process.env[ENV_KEY]
  const ORIG_KEY = process.env[KEY_ENV]

  beforeEach(async () => {
    if (ORIG_ENV === undefined) {
      delete process.env[ENV_KEY]
    } else {
      process.env[ENV_KEY] = ORIG_ENV
    }
    if (ORIG_KEY === undefined) {
      delete process.env[KEY_ENV]
    } else {
      process.env[KEY_ENV] = ORIG_KEY
    }
    process.env[KEY_ENV] = 'test-resource-plane-key-material-for-testing'
    resetEventBusForTest()
  })

  describe('OutboxProducer', () => {
    test('appends single event to outbox', async () => {
      const pool = getPgPool()
      const client = await pool.connect()
      try {
        const eventId = await OutboxProducer.append(client, {
          aggregateType: 'provider',
          aggregateId: 'test-provider',
          eventType: RESOURCE_PLANE_EVENT_TYPES.PROVIDER_CREATED,
          payload: { name: 'Test Provider' },
          revision: 1,
          sourceNodeId: 'test-node',
        })

        expect(typeof eventId).toBe('string')
        expect(eventId.length).toBeGreaterThan(0)

        // Verify it was inserted
        const res = await client.query(
          'SELECT * FROM resource_plane.outbox_events WHERE event_id = $1',
          [eventId],
        )
        expect(res.rows.length).toBe(1)
        expect(res.rows[0].event_type).toBe(RESOURCE_PLANE_EVENT_TYPES.PROVIDER_CREATED)
        expect(res.rows[0].delivered_at).toBeNull()
      } finally {
        client.release()
      }
    })

    test('appends batch of events', async () => {
      const pool = getPgPool()
      const client = await pool.connect()
      try {
        const ids = await OutboxProducer.appendBatch(client, [
          {
            aggregateType: 'provider',
            aggregateId: 'provider-1',
            eventType: RESOURCE_PLANE_EVENT_TYPES.PROVIDER_CREATED,
            payload: { name: 'Provider 1' },
            revision: 1,
            sourceNodeId: 'test-node',
          },
          {
            aggregateType: 'provider',
            aggregateId: 'provider-2',
            eventType: RESOURCE_PLANE_EVENT_TYPES.PROVIDER_UPDATED,
            payload: { name: 'Provider 2 Updated' },
            revision: 2,
            sourceNodeId: 'test-node',
          },
        ])

        expect(ids.length).toBe(2)
        ids.forEach(id => {
          expect(typeof id).toBe('string')
          expect(id.length).toBeGreaterThan(0)
        })
      } finally {
        client.release()
      }
    })
  })

  describe('OutboxConsumer', () => {
    test('marks event as delivered when publisher succeeds', async () => {
      const pool = getPgPool()
      const client = await pool.connect()
      try {
        const eventId = await OutboxProducer.append(client, {
          aggregateType: 'provider',
          aggregateId: 'test-provider',
          eventType: RESOURCE_PLANE_EVENT_TYPES.PROVIDER_CREATED,
          payload: { name: 'Test Provider' },
          revision: 1,
          sourceNodeId: 'test-node',
        })

        const consumer = new OutboxConsumer({ pollIntervalMs: 10 })
        let publishCalled = false
        const publisher = async (event: any) => {
          publishCalled = true
          return true
        }

        consumer.start(publisher)
        // Wait for polling
        await new Promise(resolve => setTimeout(resolve, 50))
        await consumer.stop()

        expect(publishCalled).toBe(true)

        // Verify event was marked as delivered
        const res = await client.query(
          'SELECT delivered_at, delivery_attempts FROM resource_plane.outbox_events WHERE event_id = $1',
          [eventId],
        )
        expect(res.rows.length).toBe(1)
        expect(res.rows[0].delivered_at).not.toBeNull()
        expect(res.rows[0].delivery_attempts).toBe(1)
      } finally {
        client.release()
      }
    })

    test('increments retry count when publisher fails', async () => {
      const pool = getPgPool()
      const client = await pool.connect()
      try {
        const eventId = await OutboxProducer.append(client, {
          aggregateType: 'provider',
          aggregateId: 'test-provider',
          eventType: RESOURCE_PLANE_EVENT_TYPES.PROVIDER_CREATED,
          payload: { name: 'Test Provider' },
          revision: 1,
          sourceNodeId: 'test-node',
        })

        const consumer = new OutboxConsumer({ pollIntervalMs: 10, maxRetries: 3 })
        let publishCalled = 0
        const publisher = async () => {
          publishCalled++
          return false // Always fail
        }

        consumer.start(publisher)
        // Wait for multiple polling attempts
        await new Promise(resolve => setTimeout(resolve, 150))
        await consumer.stop()

        expect(publishCalled).toBeGreaterThan(1)

        // Verify retry count increased
        const res = await client.query(
          'SELECT delivery_attempts, last_error FROM resource_plane.outbox_events WHERE event_id = $1',
          [eventId],
        )
        expect(res.rows.length).toBe(1)
        expect(res.rows[0].delivery_attempts).toBeGreaterThan(1)
        expect(res.rows[0].last_error).toBe('Publisher returned false')
      } finally {
        client.release()
      }
    })
  })

  describe('InboxConsumer', () => {
    test('receives and processes events', async () => {
      const pool = getPgPool()
      const client = await pool.connect()
      try {
        const consumer = new InboxConsumer({ pollIntervalMs: 10 })
        let processedEvent: any = null

        consumer.registerHandler(RESOURCE_PLANE_EVENT_TYPES.PROVIDER_CREATED, async (event) => {
          processedEvent = event
        })

        consumer.start()

        // Send an event
        await client.query(
          `INSERT INTO resource_plane.inbox_events
             (event_id, source_node_id, event_type, payload, received_at)
           VALUES ($1, $2, $3, $4, now())`,
          [
            crypto.randomUUID(),
            'test-node',
            RESOURCE_PLANE_EVENT_TYPES.PROVIDER_CREATED,
            JSON.stringify({ providerId: 'test-provider', action: 'created' }),
          ],
        )

        // Wait for processing
        await new Promise(resolve => setTimeout(resolve, 50))
        await consumer.stop()

        expect(processedEvent).not.toBeNull()
        expect(processedEvent?.event_type).toBe(RESOURCE_PLANE_EVENT_TYPES.PROVIDER_CREATED)
        expect(processedEvent.payload.providerId).toBe('test-provider')
      } finally {
        client.release()
      }
    })

    test('marks event as applied when handler succeeds', async () => {
      const pool = getPgPool()
      const client = await pool.connect()
      try {
        const eventId = crypto.randomUUID()
        await client.query(
          `INSERT INTO resource_plane.inbox_events
             (event_id, source_node_id, event_type, payload, received_at)
           VALUES ($1, $2, $3, $4, now())`,
          [
            eventId,
            'test-node',
            RESOURCE_PLANE_EVENT_TYPES.PROVIDER_CREATED,
            JSON.stringify({ test: 'data' }),
          ],
        )

        const consumer = new InboxConsumer({ pollIntervalMs: 10 })
        let handlerCalled = false
        consumer.registerHandler(RESOURCE_PLANE_EVENT_TYPES.PROVIDER_CREATED, async () => {
          handlerCalled = true
        })

        consumer.start()
        await new Promise(resolve => setTimeout(resolve, 50))
        await consumer.stop()

        expect(handlerCalled).toBe(true)

        // Verify event was marked as applied
        const res = await client.query(
          'SELECT applied_at FROM resource_plane.inbox_events WHERE event_id = $1',
          [eventId],
        )
        expect(res.rows.length).toBe(1)
        expect(res.rows[0].applied_at).not.toBeNull()
      } finally {
        client.release()
      }
    })

    test('marks event as failed when handler throws', async () => {
      const pool = getPgPool()
      const client = await pool.connect()
      try {
        const eventId = crypto.randomUUID()
        await client.query(
          `INSERT INTO resource_plane.inbox_events
             (event_id, source_node_id, event_type, payload, received_at)
           VALUES ($1, $2, $3, $4, now())`,
          [
            eventId,
            'test-node',
            RESOURCE_PLANE_EVENT_TYPES.PROVIDER_CREATED,
            JSON.stringify({ test: 'data' }),
          ],
        )

        const consumer = new InboxConsumer({ pollIntervalMs: 10 })
        consumer.registerHandler(RESOURCE_PLANE_EVENT_TYPES.PROVIDER_CREATED, async () => {
          throw new Error('Processing failed')
        })

        consumer.start()
        await new Promise(resolve => setTimeout(resolve, 50))
        await consumer.stop()

        // Verify event was marked as failed
        const res = await client.query(
          'SELECT apply_error FROM resource_plane.inbox_events WHERE event_id = $1',
          [eventId],
        )
        expect(res.rows.length).toBe(1)
        expect(res.rows[0].apply_error).toBe('Error: Processing failed')
      } finally {
        client.release()
      }
    })
  })

  describe('Helpers', () => {
    test('emitProviderEvent creates outbox event', async () => {
      const pool = getPgPool()
      const client = await pool.connect()
      try {
        const eventId = await emitProviderEvent(
          client,
          RESOURCE_PLANE_EVENT_TYPES.PROVIDER_UPDATED,
          'test-provider-123',
          { updatedField: 'test' },
          5,
          'emit-test-node',
        )

        expect(typeof eventId).toBe('string')

        const res = await client.query(
          `SELECT aggregate_type, aggregate_id, event_type, payload::text, revision, source_node_id
           FROM resource_plane.outbox_events
           WHERE event_id = $1`,
          [eventId],
        )
        expect(res.rows.length).toBe(1)
        expect(res.rows[0].aggregate_type).toBe('provider')
        expect(res.rows[0].aggregate_id).toBe('test-provider-123')
        expect(res.rows[0].event_type).toBe(RESOURCE_PLANE_EVENT_TYPES.PROVIDER_UPDATED)
        expect(res.rows[0].payload).toContain('updatedField')
        expect(Number(res.rows[0].revision)).toBe(5)
        expect(res.rows[0].source_node_id).toBe('emit-test-node')
      } finally {
        client.release()
      }
    })

    test('emitCredentialEvent creates outbox event', async () => {
      const pool = getPgPool()
      const client = await pool.connect()
      try {
        const eventId = await emitCredentialEvent(
          client,
          RESOURCE_PLANE_EVENT_TYPES.CREDENTIAL_ROTATED,
          'cred-provider',
          'cred-account',
          'apiKey',
          { rotated: true },
          3,
          'cred-emit-node',
        )

        expect(typeof eventId).toBe('string')

        const res = await client.query(
          `SELECT aggregate_type, aggregate_id, event_type, payload::text, revision, source_node_id
           FROM resource_plane.outbox_events
           WHERE event_id = $1`,
          [eventId],
        )
        expect(res.rows.length).toBe(1)
        expect(res.rows[0].aggregate_type).toBe('credential')
        expect(res.rows[0].aggregate_id).toBe('cred-provider:cred-account:apiKey')
        expect(res.rows[0].event_type).toBe(RESOURCE_PLANE_EVENT_TYPES.CREDENTIAL_ROTATED)
        expect(res.rows[0].payload).toContain('rotated')
        expect(Number(res.rows[0].revision)).toBe(3)
        expect(res.rows[0].source_node_id).toBe('cred-emit-node')
      } finally {
        client.release()
      }
    })
  })
})
