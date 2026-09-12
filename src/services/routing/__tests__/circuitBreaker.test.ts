import { beforeEach, describe, expect, it } from 'bun:test'
import {
  circuitScopeKey,
  getCircuitState,
  recordCircuitFailure,
  recordCircuitSuccess,
  resetCircuitBreaker,
  snapshotCircuitBreaker,
} from '../circuitBreaker.js'

beforeEach(() => {
  resetCircuitBreaker()
})

let sequence = 0
const uniqueProvider = () => `provider-${sequence++}`
const openCircuit = (provider: string, now = 1_000, threshold = 3) => {
  for (let i = 0; i < threshold; i++) {
    recordCircuitFailure(
      'provider',
      provider,
      undefined,
      undefined,
      {
        failureThreshold: threshold,
      },
      now + i,
    )
  }
}

describe('circuitScopeKey', () => {
  it('formats scope-specific keys', () => {
    expect(circuitScopeKey('provider', 'acme')).toBe('provider:acme')
    expect(circuitScopeKey('model', 'acme', 'opus')).toBe('model:acme/opus')
    expect(circuitScopeKey('account', 'acme', undefined, 'a1')).toBe(
      'account:acme/a1',
    )
    expect(circuitScopeKey('account', 'acme')).toBe('account:acme/default')
  })
})

describe('getCircuitState', () => {
  it('returns closed and allowed for a fresh circuit', () => {
    const provider = uniqueProvider()
    const decision = getCircuitState('provider', provider)
    expect(decision).toMatchObject({
      scope: 'provider',
      key: `provider:${provider}`,
      state: 'closed',
      allowed: true,
    })
    expect(decision.remainingFailures).toBe(3)
    expect(decision.retryAfterMs).toBe(0)
  })

  it('tracks remaining failures without opening below the threshold', () => {
    const provider = uniqueProvider()
    recordCircuitFailure('provider', provider)
    recordCircuitFailure('provider', provider)
    const decision = getCircuitState('provider', provider)
    expect(decision.state).toBe('closed')
    expect(decision.allowed).toBe(true)
    expect(decision.remainingFailures).toBe(1)
  })
})

describe('recordCircuitFailure', () => {
  it('opens after the failure threshold is reached', () => {
    const provider = uniqueProvider()
    openCircuit(provider)
    const decision = getCircuitState(
      'provider',
      provider,
      undefined,
      undefined,
      {},
      1_002,
    )
    expect(decision.state).toBe('open')
    expect(decision.allowed).toBe(false)
    expect(decision.retryAfterMs).toBeGreaterThan(0)
    expect(decision.remainingFailures).toBe(0)
  })

  it('keeps circuits with different keys independent', () => {
    openCircuit(uniqueProvider())
    const other = uniqueProvider()
    expect(getCircuitState('provider', other).allowed).toBe(true)
  })
})

describe('half-open transition', () => {
  it('moves open to half-open after the cooldown elapses', () => {
    const provider = uniqueProvider()
    openCircuit(provider, 1_000)
    expect(
      getCircuitState('provider', provider, undefined, undefined, {}, 1_001)
        .state,
    ).toBe('open')
    const halfOpen = getCircuitState(
      'provider',
      provider,
      undefined,
      undefined,
      {},
      62_000,
    )
    expect(halfOpen.state).toBe('half-open')
    expect(halfOpen.allowed).toBe(true)
    expect(halfOpen.retryAfterMs).toBe(0)
  })

  it('reopens on failure while half-open', () => {
    const provider = uniqueProvider()
    openCircuit(provider, 1_000)
    getCircuitState('provider', provider, undefined, undefined, {}, 62_000)
    const decision = recordCircuitFailure(
      'provider',
      provider,
      undefined,
      undefined,
      {},
      62_010,
    )
    expect(decision.state).toBe('open')
    expect(decision.allowed).toBe(false)
  })
})

describe('recordCircuitSuccess', () => {
  it('closes a half-open circuit after the success threshold', () => {
    const provider = uniqueProvider()
    openCircuit(provider, 1_000)
    const halfOpen = getCircuitState(
      'provider',
      provider,
      undefined,
      undefined,
      {},
      62_000,
    )
    expect(halfOpen.state).toBe('half-open')

    const closed = recordCircuitSuccess(
      'provider',
      provider,
      undefined,
      undefined,
      {},
      62_010,
    )
    expect(closed.state).toBe('closed')
    expect(closed.allowed).toBe(true)
    expect(closed.remainingFailures).toBe(3)
  })

  it('resets failures on a closed circuit without changing state', () => {
    const provider = uniqueProvider()
    recordCircuitFailure('provider', provider)
    const decision = recordCircuitSuccess('provider', provider)
    expect(decision.state).toBe('closed')
    expect(decision.remainingFailures).toBe(3)
  })
})

describe('custom config', () => {
  it('honors failureThreshold, successThreshold, and cooldownMs', () => {
    const provider = uniqueProvider()
    const config = {
      failureThreshold: 2,
      successThreshold: 2,
      cooldownMs: 5_000,
    }
    const now = 1_000
    recordCircuitFailure('model', provider, 'opus', undefined, config, now)
    const opened = recordCircuitFailure(
      'model',
      provider,
      'opus',
      undefined,
      config,
      now + 10,
    )
    expect(opened.state).toBe('open')
    expect(opened.retryAfterMs).toBe(5_000)

    const stillOpen = getCircuitState(
      'model',
      provider,
      'opus',
      undefined,
      config,
      now + 5_000,
    )
    expect(stillOpen.state).toBe('open')

    const halfOpen = getCircuitState(
      'model',
      provider,
      'opus',
      undefined,
      config,
      now + 5_010,
    )
    expect(halfOpen.state).toBe('half-open')

    const stillHalfOpen = recordCircuitSuccess(
      'model',
      provider,
      'opus',
      undefined,
      config,
      now + 5_010,
    )
    expect(stillHalfOpen.state).toBe('half-open')
    expect(stillHalfOpen.remainingSuccesses).toBe(1)

    const closed = recordCircuitSuccess(
      'model',
      provider,
      'opus',
      undefined,
      config,
      now + 5_020,
    )
    expect(closed.state).toBe('closed')
  })
})

describe('snapshotCircuitBreaker', () => {
  it('reports current decisions for tracked circuits', () => {
    resetCircuitBreaker()
    openCircuit('snapshot-target', Date.now())
    const snapshot = snapshotCircuitBreaker()
    expect(snapshot.entries['provider:snapshot-target'].state).toBe('open')
    expect(snapshot.entries['provider:snapshot-target'].allowed).toBe(false)
    expect(
      snapshot.entries['provider:snapshot-target'].retryAfterMs,
    ).toBeGreaterThan(0)
  })

  it('returns an empty snapshot after reset', () => {
    resetCircuitBreaker()
    recordCircuitFailure('provider', 'reset-target')
    resetCircuitBreaker()
    expect(snapshotCircuitBreaker().entries).toEqual({})
  })
})
