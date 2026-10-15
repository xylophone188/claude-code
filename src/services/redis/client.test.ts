import { afterEach, expect, test } from 'bun:test'
import { createServer, type Server } from 'node:net'
import { closeRedisClient, redisIsAvailable } from './client.js'

let server: Server | undefined
const oldPort = process.env.REDIS_PORT
const oldDisabled = process.env.CCB_REDIS_DISABLED

afterEach(async () => {
  await closeRedisClient()
  await new Promise<void>(
    resolve => server?.close(() => resolve()) ?? resolve(),
  )
  server = undefined
  if (oldPort === undefined) delete process.env.REDIS_PORT
  else process.env.REDIS_PORT = oldPort
  if (oldDisabled === undefined) delete process.env.CCB_REDIS_DISABLED
  else process.env.CCB_REDIS_DISABLED = oldDisabled
})

test('optional Redis disabled never opens a socket', async () => {
  process.env.CCB_REDIS_DISABLED = '1'
  expect(await redisIsAvailable()).toBe(false)
}, 5000)

test('a TCP accept without AUTH/ready cannot block bootstrap', async () => {
  delete process.env.CCB_REDIS_DISABLED
  server = createServer(() => {
    /* accept but never answer Redis handshake */
  })
  await new Promise<void>(resolve =>
    server!.listen(0, '127.0.0.1', () => resolve()),
  )
  process.env.REDIS_PORT = String((server.address() as { port: number }).port)
  const start = Date.now()
  expect(await redisIsAvailable()).toBe(false)
  expect(Date.now() - start).toBeLessThan(4000)
}, 6000)
