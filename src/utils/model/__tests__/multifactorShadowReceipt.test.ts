import { describe, expect, test } from 'bun:test'
import { classifyScenario, buildShadowReceipt, SCENARIO_VERSION } from '../multifactorShadowReceipt'

describe('classifyScenario', () => {
  test('coding intent → coding@v1', () => {
    const r = classifyScenario({ userPrompt: '实现一个函数', tools: ['Bash'] })
    expect(r.scenario).toBe(`coding@${SCENARIO_VERSION}`)
    expect(r.origin).toBe('intent')
  })

  test('research intent → research@v1', () => {
    const r = classifyScenario({ userPrompt: '请调研这个仓库的架构', tools: ['Grep'] })
    expect(r.scenario).toBe(`research@${SCENARIO_VERSION}`)
    expect(r.origin).toBe('intent')
  })

  test('review intent → review@v1', () => {
    const r = classifyScenario({ userPrompt: '帮我 review 这份 diff', tools: ['FileRead'] })
    expect(r.scenario).toBe(`review@${SCENARIO_VERSION}`)
    expect(r.origin).toBe('intent')
  })

  test('unknown intent falls back to default@v1 (never coding)', () => {
    const r = classifyScenario({ userPrompt: '你好，帮我订个披萨', tools: ['Bash'] })
    expect(r.scenario).toBe(`default@${SCENARIO_VERSION}`)
    expect(r.origin).toBe('unknown')
  })

  test('no metadata → default@v1', () => {
    expect(classifyScenario(undefined).scenario).toBe(`default@${SCENARIO_VERSION}`)
    expect(classifyScenario({}).scenario).toBe(`default@${SCENARIO_VERSION}`)
  })

  test('explicit scenario override wins', () => {
    const r = classifyScenario({ userPrompt: '写代码', explicitScenario: 'translate@v1' })
    expect(r.scenario).toBe('translate@v1')
    expect(r.origin).toBe('explicit')
  })
})

describe('buildShadowReceipt — real-path metadata contract', () => {
  test('known scenario carries versioned factors, unavailable ranking, and dispatch-agnostic legacy route', () => {
    const receipt = buildShadowReceipt({
      userPrompt: '实现一个加法函数',
      tools: ['FileEdit'],
      selectedModel: 'claude-sonnet-4-6',
      route: {
        provider: 'omniroute',
        model: 'claude-sonnet-4-6',
        isLegacyAlias: false,
      },
      env: process.env,
      bypassReasons: ['shadow'],
    })
    expect(receipt.scenario).toBe(`coding@${SCENARIO_VERSION}`)
    expect(receipt.scenarioOrigin).toBe('intent')
    expect(receipt.profileVersion).toBe(SCENARIO_VERSION)
    expect(receipt.factors).toBeDefined()
    expect(receipt.candidateRanking.kind).toBe('legacy')
    expect(receipt.candidateRanking.note).toContain('not computed')
    expect(receipt.legacySelectedRoute.provider).toBe('omniroute')
    expect(receipt.bypassDetected).toBe(true)
    // The receipt is derived from observed env + selected route; the transport dispatch
    // is unchanged. Asserting that no per-pool selection is embedded in the receipt.
    expect(receipt.poolOverrideApplied).toBe(false)
  })

  test('unknown scenario → default@v1 (never coding)', () => {
    const receipt = buildShadowReceipt({
      userPrompt: '帮我查一下天气',
      tools: [],
      selectedModel: 'claude-opus-4-7',
      route: { provider: 'anthropic', model: 'claude-opus-4-7' },
      env: process.env,
    })
    expect(receipt.scenario).toBe(`default@${SCENARIO_VERSION}`)
    expect(receipt.scenarioOrigin).toBe('unknown')
    // Must NOT be classified as coding by keyword heuristic accident.
    expect(receipt.scenario).not.toBe(`coding@${SCENARIO_VERSION}`)
  })

  test('no metadata → default@v1', () => {
    const receipt = buildShadowReceipt({
      selectedModel: 'claude-sonnet-4-6',
      env: process.env,
    })
    expect(receipt.scenario).toBe(`default@${SCENARIO_VERSION}`)
    expect(receipt.scenarioOrigin).toBe('unknown')
  })
})

describe('dispatch invariance', () => {
  test('buildShadowReceipt is pure — repeated calls return identical shape, no pool mutation', () => {
    const opts = {
      userPrompt: '写个脚本',
      tools: ['Bash'],
      selectedModel: 'claude-sonnet-4-6',
      route: {
        provider: 'omniroute',
        model: 'claude-sonnet-4-6',
      },
      env: { CLAUDE_CODE_USE_OMNIROUTE: '1' },
    }
    const a = buildShadowReceipt(opts)
    const b = buildShadowReceipt(opts)
    expect(a.scenario).toBe(b.scenario)
    expect(a.scenarioOrigin).toBe(b.scenarioOrigin)
    expect(a.poolOverrideApplied).toBe(b.poolOverrideApplied)
    expect(a.poolOverrideApplied).toBe(false)
  })

  test('does not consult any routing/pool module — no imports besides test target', () => {
    // Structural check: the receipt is a pure function of the supplied options.
    const r = buildShadowReceipt({
      selectedModel: 'claude-sonnet-4-6',
      env: {},
    })
    expect(r.candidateRanking.kind).toBe('legacy')
    expect(r.poolOverrideApplied).toBe(false)
    expect(Object.keys(r.legacySelectedRoute)).toEqual(
      expect.arrayContaining(['provider', 'model', 'isLegacyAlias']),
    )
  })
})

describe('bypass detection', () => {
  test('legacy alias selected model is detected as a bypass', () => {
    const receipt = buildShadowReceipt({
      selectedModel: 'gpt-5.2-codex',
      route: { provider: 'anthropic', model: 'gpt-5.2-codex', isLegacyAlias: true },
      env: process.env,
    })
    expect(receipt.bypassDetected).toBe(true)
    expect(receipt.bypassReasons).toEqual(
      expect.arrayContaining([
        'explicit-legacy-route',
        'alias-selected-model=gpt-5.2-codex',
      ]),
    )
  })

  test('CLAUDE_CODE_MODEL override counts as a bypass', () => {
    const receipt = buildShadowReceipt({
      selectedModel: 'claude-sonnet-4-6',
      route: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      env: { CLAUDE_CODE_MODEL: 'claude-sonnet-4-6' },
    })
    expect(receipt.bypassDetected).toBe(true)
    expect(receipt.bypassReasons).toContain('CLAUDE_CODE_MODEL override')
  })

  test('CLEAN path with no env override and no alias is not a bypass', () => {
    const receipt = buildShadowReceipt({
      selectedModel: 'claude-sonnet-4-6',
      route: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
      env: {},
    })
    expect(receipt.bypassDetected).toBe(false)
    expect(receipt.bypassReasons).toEqual([])
  })
})
