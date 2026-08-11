import { describe, expect, it } from 'bun:test'
import {
  chooseAccount,
  clearModelFailure,
  isModelFailure,
  markAccountFailure,
  markModelFailure,
  providerRequestSlotKey,
  resetProviderRequestSlotsForTest,
  waitForProviderRequestSlot,
} from '../accountPool.js'

describe('CCB account pool', () => {
  it('skips the final ten percent', () => {
    expect(
      chooseAccount({
        id: 'x',
        kind: 'openai-compat',
        baseUrl: 'https://x.test/v1',
        defaultModel: 'm',
        compatRule: 'permissive',
        accounts: [
          { id: 'low', apiKey: 'a', quotaRemaining: 10 },
          { id: 'good', apiKey: 'b', quotaRemaining: 11 },
        ],
      }),
    ).toEqual({ id: 'good', apiKey: 'b' })
  })

  it('skips a cooled-down account', () => {
    const provider = {
      id: 'x-cooldown',
      kind: 'openai-compat' as const,
      baseUrl: 'https://x.test/v1',
      defaultModel: 'm',
      compatRule: 'permissive' as const,
      accounts: [
        { id: 'bad', apiKey: 'a' },
        { id: 'good', apiKey: 'b' },
      ],
    }
    markAccountFailure(provider.id, 'bad', 60_000)
    expect(chooseAccount(provider)?.id).toBe('good')
  })

  it('cools down only the failed provider model', () => {
    markModelFailure('dsml', 'bad-model')

    expect(isModelFailure('dsml', 'bad-model')).toBe(true)
    expect(isModelFailure('dsml', 'good-model')).toBe(false)
    expect(isModelFailure('other-provider', 'bad-model')).toBe(false)

    clearModelFailure('dsml', 'bad-model')
    expect(isModelFailure('dsml', 'bad-model')).toBe(false)
  })

  it('uses an NVIDIA account-specific request limiter key', () => {
    expect(providerRequestSlotKey('nvidia', 'account-a')).toBe(
      'nvidia/account-a',
    )
    expect(providerRequestSlotKey('nvidia', 'account-b')).toBe(
      'nvidia/account-b',
    )
    expect(providerRequestSlotKey('nvidia')).toBe('nvidia')
    expect(providerRequestSlotKey('other', 'account-a')).toBe('other')
  })

  it('spaces same NVIDIA account requests without delaying another account', async () => {
    resetProviderRequestSlotsForTest()
    await waitForProviderRequestSlot('nvidia', 'account-a')

    const sameAccount = waitForProviderRequestSlot('nvidia', 'account-a')
    const otherAccount = waitForProviderRequestSlot('nvidia', 'account-b')
    const first = await Promise.race([
      otherAccount.then(() => 'other'),
      sameAccount.then(() => 'same'),
    ])

    expect(first).toBe('other')
    await sameAccount
  }, 2_000)
})
