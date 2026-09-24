import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import {
  __resetShadowReceiptForTesting,
  captureShadowReceiptsFromSse,
  classifyTransportBypass,
  emitShadowReceipt,
  emitShadowReceiptFromHeaders,
  emitShadowReceiptFromHeadersIfPresent,
  emitTransportBypassReceipt,
  getShadowReceipt,
  getLastShadowReceipt,
} from '../adapter.js'

describe('emitShadowReceiptFromHeaders', () => {
  beforeEach(() => __resetShadowReceiptForTesting())

  test('records an immutable receipt from real headers', () => {
    const headers = new Headers({
      'x-shadow-receipt-scenario': 'coding',
      'x-shadow-receipt-scenario-origin': 'known',
      'x-shadow-receipt-profile-version': 'v2',
      'x-shadow-receipt-factor-version': 'f3',
      'x-shadow-receipt-candidate-ranking': 'a|b',
      'x-shadow-receipt-selected-route': 'openai:deepseek',
    })

    const receipt = emitShadowReceiptFromHeaders(headers)

    expect(receipt).toEqual({
      scenario: 'coding',
      scenarioOrigin: 'known',
      profileVersion: 'v2',
      factorVersion: 'f3',
      factorSnapshot: null,
      candidateRanking: 'a|b',
      legacySelectedRoute: 'openai:deepseek',
      bypassed: false,
    })
    expect(getShadowReceipt()).toBe(receipt)
  })

  test('returns the existing receipt without re-emitting when unchanged', () => {
    const first = emitShadowReceiptFromHeaders(
      new Headers({ 'x-shadow-receipt-scenario': 'coding' }),
    )
    const second = emitShadowReceiptFromHeaders(
      new Headers({ 'x-shadow-receipt-scenario': 'coding' }),
    )

    expect(second).toBe(first)
  })

  test('unknown profile stays default@v1 (never coding)', () => {
    const receipt = emitShadowReceiptFromHeaders(
      new Headers({ 'x-shadow-receipt-profile-version': '???' }),
    )

    expect(receipt).toMatchObject({
      scenario: 'unknown',
      profileVersion: 'default@v1',
      scenarioOrigin: 'unknown',
    })
  })

  test('returns null when headers are not present', () => {
    const receipt = emitShadowReceiptFromHeaders(new Headers())

    expect(receipt).toBeNull()
    expect(getShadowReceipt()).toBeNull()
  })

  test('emitShadowReceiptFromHeadersIfPresent does not create empty receipt', () => {
    const receipt = emitShadowReceiptFromHeadersIfPresent(new Headers())

    expect(receipt).toBeNull()
    expect(getShadowReceipt()).toBeNull()
  })

  test('factor version and factor snapshot are preserved when supplied', () => {
    const receipt = emitShadowReceiptFromHeaders(
      new Headers({
        'x-shadow-receipt-factor-version': 'f1',
        'x-shadow-receipt-factor-snapshot': 'snapshot-xyz',
      }),
    )

    expect(receipt).toMatchObject({
      factorVersion: 'f1',
      factorSnapshot: 'snapshot-xyz',
    })
  })

  test('candidate ranking fallback marks legacy/unavailable', () => {
    const receipt = emitShadowReceiptFromHeaders(new Headers({}))

    expect(receipt.candidateRanking).toBe('unavailable')
  })
})

describe('emitShadowReceipt', () => {
  beforeEach(() => __resetShadowReceiptForTesting())

  test('normalizes unknown inputs to default@v1', () => {
    const receipt = emitShadowReceipt({
      scenario: 'weird',
      profileVersion: '',
    })

    expect(receipt).toEqual({
      scenario: 'weird',
      scenarioOrigin: 'unknown',
      profileVersion: 'default@v1',
      factorVersion: 'unavailable',
      factorSnapshot: null,
      candidateRanking: 'unavailable',
      legacySelectedRoute: null,
      bypassed: false,
    })
  })
})

describe('emitTransportBypassReceipt', () => {
  beforeEach(() => __resetShadowReceiptForTesting())

  test('records a legacy bypass with the exact route string', () => {
    const receipt = emitTransportBypassReceipt('codex:openai')

    expect(receipt).toEqual({
      scenario: 'unknown',
      scenarioOrigin: 'unknown',
      profileVersion: 'default@v1',
      factorVersion: 'unavailable',
      factorSnapshot: null,
      candidateRanking: 'legacy',
      legacySelectedRoute: 'codex:openai',
      bypassed: true,
    })
  })
})

describe('classifyTransportBypass', () => {
  test('detects codex direct provider bypass', () => {
    expect(classifyTransportBypass({ provider: 'codex' })).toEqual({
      bypassed: true,
      route: 'codex:direct',
    })
  })

  test('does not flag non-codex providers', () => {
    expect(classifyTransportBypass({ provider: 'openai' })).toEqual({
      bypassed: false,
      route: null,
    })
  })
})

describe('captureShadowReceiptsFromSse', () => {
  beforeEach(() => __resetShadowReceiptForTesting())

  test('parses leading SSE comments into an immutable receipt', () => {
    const body = [
      ': omniroute-keepalive',
      '',
      ': x-shadow-receipt-scenario=coding',
      ': x-shadow-receipt-scenario-origin=known',
      ': x-shadow-receipt-profile-version=v1',
      ': x-shadow-receipt-factor-version=f1',
      ': x-shadow-receipt-selected-route=openai:deepseek',
      'data: {"id":"chatcmpl-test"}',
      '',
    ].join('\n')

    const captured = captureShadowReceiptsFromSse(body)

    expect(captured).toMatchObject({
      scenario: 'coding',
      profileVersion: 'v1',
      bypassed: false,
    })
    expect(getShadowReceipt()).toBe(captured)
  })
})

describe('getLastShadowReceipt', () => {
  beforeEach(() => __resetShadowReceiptForTesting())

  test('returns null before any receipt is emitted', () => {
    expect(getLastShadowReceipt()).toBeNull()
  })

  test('returns the latest shadow receipt after emit', () => {
    emitShadowReceiptFromHeaders(
      new Headers({ 'x-shadow-receipt-scenario': 'coding' }),
    )
    expect(getLastShadowReceipt()).toMatchObject({ scenario: 'coding' })
  })

  afterEach(() => __resetShadowReceiptForTesting())
})
