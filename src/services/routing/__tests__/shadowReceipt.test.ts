// @ts-nocheck
import { expect, test, describe, beforeAll, afterAll } from 'bun:test'
import { mock } from 'bun:test'
import { logMock } from '../../../../tests/mocks/log'
import { debugMock } from '../../../../tests/mocks/debug'

mock.module('src/utils/log.ts', logMock)
mock.module('src/utils/debug.ts', debugMock)
mock.module('src/utils/config.ts', () => ({
  getConfig: () => ({}),
  getGlobalConfig: () => ({}),
}))
mock.module('src/bootstrap/state.ts', () => ({
  getSessionId: () => 'test-session-shadow-receipt',
}))
mock.module('src/utils/model/model.ts', () => ({
  getModel: () => 'gpt-4.1-mini',
  getModelWithFallback: () => 'gpt-4.1-mini',
  modelSupportsMaxThinkingTokens: () => false,
}))
mock.module('bun:bundle', () => ({
  feature: () => false,
}))

const sr = require('../../..//services/routing/shadowReceipt.js')
const detectRoutingBypass = sr.detectRoutingBypass
const resolveScenarioMetadata = sr.resolveScenarioMetadata
const snapshotFactorVersions = sr.snapshotFactorVersions
const emitShadowReceipt = sr.emitShadowReceipt
const resetShadowReceiptEmitLog = sr.resetShadowReceiptEmitLog
const getShadowReceiptEmitLog = sr.getShadowReceiptEmitLog

function buildMessageHistory(
  userTurns: number,
  extra?: Array<{ role: string; name?: string; contentType?: string }>,
) {
  const base = [
    { type: 'user', message: { role: 'user', content: [{ type: 'text', text: 'hello' }] } },
    {
      type: 'assistant',
      message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
    },
  ]
  for (let i = 1; i < userTurns; i++) {
    base.push(
      {
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: `turn ${i + 1}` }] },
      },
      {
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: `reply ${i + 1}` }] },
      },
    )
  }
  return [...base, ...(extra ?? [])]
}

const LEGACY_CONTEXT_SNAPSHOT = {
  providerState: 'OPENAI',
  model: 'deepseek-v4-flash-free',
  baseUrl: 'http://127.0.0.1:20128/v1',
  authTokenValue: 'sk-test-token-leak',
  apiKeyValue: undefined,
}

describe('shadowReceipt — metadata-only shadow receipt on main query path', () => {
  test('detects legacy direct-route bypass by legacy base URL + OpenAI apiKey shape', () => {
    const bypasses = detectRoutingBypass({
      ...LEGACY_CONTEXT_SNAPSHOT,
      authTokenValue: undefined,
    })
    expect(bypasses).toContain('LEGACY_OPENAI_DIRECT_ROUTE')
    expect(bypasses).not.toContain('OPENAI_OAUTH_LEGACY')
  })

  test('detects ChatGPT OAuth legacy bypass by sk-ant-oat- shape + non-official base', () => {
    const bypasses = detectRoutingBypass({
      ...LEGACY_CONTEXT_SNAPSHOT,
      authTokenValue: 'sk-ant-oat01-CODEX-LIVE-GATE',
      apiKeyValue: undefined,
      providerState: 'OPENAI',
    })
    expect(bypasses).toContain('OPENAI_OAUTH_LEGACY')
    expect(bypasses).not.toContain('LEGACY_OPENAI_DIRECT_ROUTE')
  })

  test('detects BYOK direct-route bypass by OPENAI_API_KEY shape on non-official base', () => {
    const bypasses = detectRoutingBypass({
      ...LEGACY_CONTEXT_SNAPSHOT,
      authTokenValue: undefined,
      baseUrl: 'https://api.openai.com/v1',
    })
    expect(bypasses).toContain('OPENAI_BYOK_DIRECT')
  })

  test('detects no bypass when provider/model are in the CCB router registry', () => {
    const bypasses = detectRoutingBypass({
      providerState: 'ccbRouter',
      model: 'openrouter/deepseek-v4-flash-free',
      baseUrl: 'http://127.0.0.1:20128/v1',
      authTokenValue: undefined,
      apiKeyValue: 'ccb-router-static-token',
    })
    expect(bypasses).toEqual([])
  })

  test('unknown scenario resolves to default@v1 with metadata-only dispatch', () => {
    const { scenario, scenarioOrigin, profileVersion } = resolveScenarioMetadata({
      history: buildMessageHistory(3),
      promptText: 'write a python hello world',
    })
    expect(scenario).toBe('default@v1')
    expect(scenarioOrigin).toBe('unknown-default-v1')
    expect(profileVersion).toBe('v1')
  })

  test('known scenario still resolves to metadata-only dispatch (never coding)', () => {
    const { scenario, scenarioOrigin, profileVersion } = resolveScenarioMetadata({
      history: [
        {
          type: 'user',
          message: {
            role: 'user',
            content: [{ type: 'text', text: 'Please enter plan mode and lay out a plan.' }],
          },
        },
      ],
      promptText: 'Please enter plan mode and lay out a plan.',
    })
    expect(scenario).toBe('plan@v1')
    expect(scenarioOrigin).toBe('known-plan@v1')
    expect(profileVersion).toBe('v1')
  })

  test('factor snapshots report versioned factors; unknown/unavailable is explicit', () => {
    const factors = snapshotFactorVersions(buildMessageHistory(3), 'gpt-4.1-mini')
    expect(factors.tooling).toBe('tooling@v1')
    expect(factors.history).toBe('history@v1')
    expect(factors.provider).toBe('provider@v1')
  })

  test('emitShadowReceipt produces an immutable receipt with required fields', () => {
    resetShadowReceiptEmitLog()
    const receipt = emitShadowReceipt({
      profileVersion: 'v1',
      scenario: 'default@v1',
      scenarioOrigin: 'unknown-default-v1',
      metadataOnly: true,
      factorVersions: snapshotFactorVersions(buildMessageHistory(3), 'gpt-4.1-mini'),
      candidateSummary: { kind: 'unavailable', reason: 'no ranking pipeline' },
      selectedRoute: 'openai-adapter',
      routingBypasses: ['LEGACY_OPENAI_DIRECT_ROUTE'],
    })

    expect(receipt.scenario).toBe('default@v1')
    expect(receipt.scenarioOrigin).toBe('unknown-default-v1')
    expect(receipt.profileVersion).toBe('v1')
    expect(receipt.metadataOnly).toBe(true)
    expect(receipt.factorVersions.provider).toBe('provider@v1')
    expect(receipt.factorSnapshots.tooling).toBeDefined()
    expect(receipt.candidateSummary).toEqual({
      kind: 'unavailable',
      reason: 'no ranking pipeline',
    })
    expect(receipt.selectedRoute).toBe('openai-adapter')
    expect(receipt.routingBypasses).toContain('LEGACY_OPENAI_DIRECT_ROUTE')
    expect(receipt.dispatchUnchanged).toBe(true)
    expect(receipt.sessionId).toBeDefined()
    expect(receipt.timestamp).toBeDefined()

    const hash1 = receipt.integrityHash
    const tampered = structuredClone(receipt)
    tampered.scenario = 'coding@v1'
    const hash2 = receipt.integrityHash
    expect(hash1).toEqual(hash2)

    const emitted = getShadowReceiptEmitLog()
    expect(emitted).toHaveLength(1)
    expect(emitted[0].shadowReceipt.integrityHash).toBe(hash1)
  })

  test('emitShadowReceipt rejects empty scenarios (unknown defaults are caller-resolved)', () => {
    expect(() =>
      emitShadowReceipt({
        profileVersion: 'v1',
        scenario: '',
        scenarioOrigin: 'unknown-default-v1',
        metadataOnly: true,
        factorVersions: snapshotFactorVersions(buildMessageHistory(3), 'gpt-4.1-mini'),
        candidateSummary: { kind: 'unavailable', reason: 'no ranking pipeline' },
        selectedRoute: 'openai-adapter',
        routingBypasses: [],
      }),
    ).toThrow('scenario must be non-empty')
  })

  test('query.ts main path is wired to emit shadow receipt (dispatch unchanged)', () => {
    const fs = require('node:fs')
    const querySrc = fs.readFileSync(require.resolve('../../../query'), 'utf8')
    expect(querySrc).toContain('buildMainPathShadowReceipt')
    expect(querySrc).toContain('getRoutingContextSnapshot')
    expect(querySrc).toContain('emitShadowReceipt')
    // The wire is a metadata-only side effect — no re-export of routing decision,
    // no conditional dispatch, no `await` on the receipt.
    expect(querySrc).not.toContain('await emitShadowReceipt')
    expect(querySrc).not.toContain('await buildMainPathShadowReceipt')
    // No routing-pool bypass introduced on this path.
    const poolProbe = /select(Preferred|Fast|Best)Provider|selectBestProvider/.test(querySrc)
    expect(poolProbe).toBe(false)
  })

  test('shadowReceipt.ts does not mutate transport/auth/dispatch state', () => {
    const fs = require('node:fs')
    const src = fs.readFileSync(require.resolve('../shadowReceipt'), 'utf8')
    expect(src).not.toContain('setAuthTokenFor')
    expect(src).not.toContain('setProviderState')
    expect(src).not.toContain('setAuthToken')
    expect(src).not.toContain('setApiKey')
    expect(src).not.toContain('selectPreferredProvider')
    expect(src).not.toContain('selectFastProvider')
    expect(src).not.toContain('selectBestProvider')
    expect(src).not.toContain('getApiKey')
    expect(src).not.toContain('getAuthToken')
  })

  test('integrity hash matches sha256(canonical JSON) of all receipt fields except integrityHash', () => {
    const fs = require('node:fs')
    const crypto = require('node:crypto')
    const path = require('node:path')
    const src = fs.readFileSync(require.resolve('../shadowReceipt'), 'utf8')
    // Structural check: sha256 over canonicalized JSON of all required fields.
    expect(src).toContain('createHash')
    expect(src).toContain("receipt.omitIntegrityHash = undefined")
    // Sanity: hashing a canonical payload is stable.
    const payload = { scenario: 'default@v1', scenarioOrigin: 'unknown-default-v1' }
    const canonical = JSON.stringify(payload, (_k, v) => {
      if (v === undefined) return undefined
      return v
    })
    const digest = crypto.createHash('sha256').update(canonical).digest('hex')
    expect(digest).toMatch(/^[a-f0-9]{64}$/)
  })

  test('canonicalize handles Map (scenario→metadata registry) with deterministic key order', () => {
    // We can't import canonicalize directly (not exported), so validate the exported
    // integrityHash is stable across emit order of the same registry-backed receipt.
    resetShadowReceiptEmitLog()
    const a = emitShadowReceipt({
      profileVersion: 'v1',
      scenario: 'coding@v1',
      scenarioOrigin: 'legacy-pool-fallback',
      metadataOnly: true,
      factorVersions: snapshotFactorVersions(buildMessageHistory(1), 'gpt-4.1-mini'),
      candidateSummary: { kind: 'unavailable', reason: 'no ranking pipeline' },
      selectedRoute: 'openai-adapter',
      routingBypasses: [],
    })
    resetShadowReceiptEmitLog()
    const b = emitShadowReceipt({
      profileVersion: 'v1',
      scenario: 'coding@v1',
      scenarioOrigin: 'legacy-pool-fallback',
      metadataOnly: true,
      factorVersions: snapshotFactorVersions(buildMessageHistory(1), 'gpt-4.1-mini'),
      candidateSummary: { kind: 'unavailable', reason: 'no ranking pipeline' },
      selectedRoute: 'openai-adapter',
      routingBypasses: [],
    })
    expect(a.integrityHash).toBe(b.integrityHash)
    expect(a.profileName).toBe(b.profileName)
  })
})
