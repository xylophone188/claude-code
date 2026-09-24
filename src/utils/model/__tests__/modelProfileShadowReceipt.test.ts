import { describe, expect, test } from 'bun:test'
import type { ProviderModel, ToolInfo } from 'src/utils/model/types.js'
import { createShadowReceipt, toShadowScenario } from '../modelProfileShadowReceipt.js'

type ShadowReceipt = ReturnType<typeof createShadowReceipt>

function withScenario(
  model: ProviderModel,
  scenario: 'coding' | 'analysis' | 'writing' | 'design',
): ProviderModel {
  return { ...model, scenario }
}

function withRoute(
  model: ProviderModel,
  route: 'auto' | 'free' | 'premium' | 'custom',
): ProviderModel {
  return { ...model, route }
}

const BASELINE_MODEL: ProviderModel = {
  provider: 'anthropic',
  model: 'claude-opus-4-6',
  contextWindow: 200_000,
  cost: { input: 1.5, cache_read: 0.15, cache_write: 1.8, output: 7.5 },
  maxOutputTokens: 32_000,
  tools: {} as ToolInfo,
  capabilities: {},
}

describe('toShadowScenario', () => {
  test('maps unknown scenarios to default (never coding)', () => {
    expect(toShadowScenario(undefined)).toBe('default')
    expect(toShadowScenario(null)).toBe('default')
    expect(toShadowScenario('garbage')).toBe('default')
    expect(toShadowScenario('coding')).toBe('coding')
    expect(toShadowScenario('analysis')).toBe('analysis')
    expect(toShadowScenario('writing')).toBe('writing')
    expect(toShadowScenario('design')).toBe('design')
  })
})

describe('createShadowReceipt', () => {
  test('real dispatch path produces a complete immutable receipt', () => {
    const receipt = createShadowReceipt(
      withScenario(withRoute(BASELINE_MODEL, 'free'), 'coding'),
      'query',
      false,
    )
    expect(receipt.scenario).toBe('coding')
    expect(receipt.scenarioOrigin).toBe('resolved')
    expect(receipt.profileVersion).toBe('v1')
    expect(receipt.legacySelectedRoute).toBe('direct_query')
    expect(receipt.bypassDetected).toBe(false)
    expect(receipt.factorVersion.stateVersion).not.toBeNull()
    expect(receipt.candidateRanking).toBe('legacy')
    expect(receipt.routingSnapshot).toBe('unavailable')
    expect(receipt.emittedAt).not.toBe('')
  })

  test('unknown scenario falls back to default@v1', () => {
    const receipt = createShadowReceipt(BASELINE_MODEL, 'query', false)
    expect(receipt.scenario).toBe('default')
    expect(receipt.scenarioOrigin).toBe('unknown')
    expect(receipt.profileVersion).toBe('default@v1')
  })

  test('does not mutate the input model', () => {
    const input = withScenario(BASELINE_MODEL, 'coding')
    const before = JSON.stringify(input)
    createShadowReceipt(input, 'query', false)
    expect(JSON.stringify(input)).toBe(before)
  })
})

describe('bypass detection', () => {
  test('legacy non-route-resolved model is flagged as bypass', () => {
    const receipt = createShadowReceipt(BASELINE_MODEL, 'query', true)
    expect(receipt.bypassDetected).toBe(true)
  })

  test('route-resolved model is not a bypass', () => {
    const receipt = createShadowReceipt(withRoute(BASELINE_MODEL, 'premium'), 'query', false)
    expect(receipt.bypassDetected).toBe(false)
  })
})

describe('dispatch invariance', () => {
  const routes = ['auto', 'free', 'premium', 'custom'] as const
  const scenarios = ['coding', 'analysis', 'writing', 'design'] as const

  test.each(routes)(
    'shadow receipt does not change selected model or route for route=%s',
    (route) => {
      const model = withRoute(BASELINE_MODEL, route)
      const modelBefore = JSON.stringify({ provider: model.provider, model: model.model, route: model.route })
      createShadowReceipt(model, 'query', false)
      const modelAfter = JSON.stringify({ provider: model.provider, model: model.model, route: model.route })
      expect(modelAfter).toBe(modelBefore)
    },
  )

  test.each(scenarios)(
    'shadow receipt does not change selected model for scenario=%s',
    (scenario) => {
      const model = withScenario(BASELINE_MODEL, scenario)
      const before = JSON.stringify({ provider: model.provider, model: model.model, scenario: model.scenario })
      createShadowReceipt(model, 'query', false)
      const after = JSON.stringify({ provider: model.provider, model: model.model, scenario: model.scenario })
      expect(after).toBe(before)
    },
  )
})
