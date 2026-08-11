import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { fetchCodeBuddyQuota } from '../codebuddy.js'

const FAKE_URL =
  'https://copilot.tencent.com/v2/billing/meter/get-user-resource'
const FAKE_KEY = 'sk-cb-1'

interface FetchCall {
  url: string
  init: RequestInit
}
let calls: FetchCall[]
let handler: ((url: string, init: RequestInit) => Promise<unknown>) | undefined

const originalFetch = globalThis.fetch

function setResponse(mock: () => unknown) {
  handler = async () => mock()
}

// 2 days + 1s gap marks a recurring refill pack (REFILL_GAP_MS = 2 days).
function account(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const cycleEnd = 1_700_000_000_000
  return {
    CycleEndTime: cycleEnd,
    DeductionEndTime: cycleEnd + 2 * 24 * 60 * 60 * 1000 + 1000,
    CycleCapacitySizePrecise: '100',
    CycleCapacityUsedPrecise: '30',
    CycleCapacitySize: 100,
    CycleCapacityUsed: 30,
    ...overrides,
  }
}

function refillPayload(accounts: unknown[]): unknown {
  return {
    code: 0,
    data: { Response: { Data: { Accounts: accounts } } },
  }
}

beforeEach(() => {
  calls = []
  handler = undefined
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    const body = await handler?.(url, init)
    return new Response(JSON.stringify(body), { status: 200 })
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('fetchCodeBuddyQuota', () => {
  test('returns remaining percentage of the earliest refill pack', async () => {
    setResponse(() =>
      refillPayload([account(), account({ CycleCapacityUsedPrecise: '80' })]),
    )
    const quota = await fetchCodeBuddyQuota(FAKE_URL, FAKE_KEY)
    // agggregated 按 earliest cycle end 的主包: (100-30)/100*100 = 70
    expect(quota).toBe(70)
  })

  test('prefers Precise fields over plain numeric ones', async () => {
    setResponse(() =>
      refillPayload([
        account({
          CycleCapacitySizePrecise: '1000',
          CycleCapacityUsedPrecise: '250',
          CycleCapacitySize: 999,
          CycleCapacityUsed: 999,
        }),
      ]),
    )
    const quota = await fetchCodeBuddyQuota(FAKE_URL, FAKE_KEY)
    expect(quota).toBe(75)
  })

  test('returns undefined when only one-shot bonus packs exist', async () => {
    const bonus = {
      CycleEndTime: 1_700_000_000_000,
      DeductionEndTime: 1_700_000_000_000 - 1, // gap < 2 days → not refill
      CapacityCapacitySize: 100, // Capacity* only (no Cycle*)
    }
    setResponse(() => refillPayload([bonus]))
    const quota = await fetchCodeBuddyQuota(FAKE_URL, FAKE_KEY)
    expect(quota).toBeUndefined()
  })

  test('returns undefined when no refill pack and accounts exist', async () => {
    setResponse(() => refillPayload([]))
    const quota = await fetchCodeBuddyQuota(FAKE_URL, FAKE_KEY)
    expect(quota).toBeUndefined()
  })

  test('returns undefined on 401', async () => {
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ code: 'auth failed' }), { status: 401 }),
      )) as unknown as typeof fetch
    const quota = await fetchCodeBuddyQuota(FAKE_URL, FAKE_KEY)
    expect(quota).toBeUndefined()
  })

  test('returns undefined when response code is non-zero', async () => {
    setResponse(() => ({ code: -1, message: 'error' }))
    const quota = await fetchCodeBuddyQuota(FAKE_URL, FAKE_KEY)
    expect(quota).toBeUndefined()
  })

  test('returns undefined when fetch throws (fail-open)', async () => {
    globalThis.fetch = (() =>
      Promise.reject(new Error('network down'))) as unknown as typeof fetch
    const quota = await fetchCodeBuddyQuota(FAKE_URL, FAKE_KEY)
    expect(quota).toBeUndefined()
  })

  test('returns undefined with no apiKey', async () => {
    const quota = await fetchCodeBuddyQuota(FAKE_URL, '')
    expect(quota).toBeUndefined()
  })

  test('sends POST with Bearer auth to the usage URL', async () => {
    setResponse(() => refillPayload([account()]))
    await fetchCodeBuddyQuota(FAKE_URL, FAKE_KEY)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(FAKE_URL)
    expect(calls[0].init.method).toBe('POST')
    expect(calls[0].init.headers).toMatchObject({
      Authorization: `Bearer ${FAKE_KEY}`,
    })
    expect(calls[0].init.body).toBe('{}')
  })

  test('appends provider-specific headers', async () => {
    setResponse(() => refillPayload([account()]))
    await fetchCodeBuddyQuota(FAKE_URL, FAKE_KEY, {
      'x-codebuddy-request': '1',
    })
    expect(calls[0].init.headers).toMatchObject({ 'x-codebuddy-request': '1' })
  })

  test('accounts without a parseable cycle end are ignored', async () => {
    setResponse(() => refillPayload([{ CycleEndTime: 'garbage' }]))
    const quota = await fetchCodeBuddyQuota(FAKE_URL, FAKE_KEY)
    expect(quota).toBeUndefined()
  })

  test('clamps remaining to 0..100', async () => {
    setResponse(() =>
      refillPayload([
        account({
          CycleCapacitySizePrecise: '10',
          CycleCapacityUsedPrecise: '40',
        }),
      ]),
    )
    const quota = await fetchCodeBuddyQuota(FAKE_URL, FAKE_KEY)
    expect(quota).toBe(0)
  })
})
