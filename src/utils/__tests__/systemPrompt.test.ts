import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { feature } from 'bun:bundle'
import { buildEffectiveSystemPrompt } from '../systemPrompt'

const defaultPrompt = ['You are a helpful assistant.', 'Follow instructions.']
const environmentKeys = [
  'CCB_ENV',
  'CCB_FORCE_ADVISOR_WORKFLOW',
  'OMNIROUTE_SERVER_ROUTING',
] as const
let savedEnvironment: Record<
  (typeof environmentKeys)[number],
  string | undefined
>

function buildPrompt(overrides: Record<string, unknown> = {}) {
  return buildEffectiveSystemPrompt({
    mainThreadAgentDefinition: undefined,
    toolUseContext: { options: {} as any },
    customSystemPrompt: undefined,
    defaultSystemPrompt: defaultPrompt,
    appendSystemPrompt: undefined,
    ...overrides,
  })
}

function hasLocalModes(): boolean {
  if (feature('CAVEMAN')) return true
  if (feature('PONYTAIL')) return true
  if (feature('RTK')) return true
  return false
}

function expectPrompt(result: Iterable<string>, expected: string[]): void {
  const values = Array.from(result)
  expect(
    values.slice(0, hasLocalModes() ? expected.length : values.length),
  ).toEqual(expected)
}

beforeEach(() => {
  savedEnvironment = Object.fromEntries(
    environmentKeys.map(key => [key, process.env[key]]),
  ) as Record<(typeof environmentKeys)[number], string | undefined>
  for (const key of environmentKeys) delete process.env[key]
})

afterEach(() => {
  for (const key of environmentKeys) {
    const value = savedEnvironment[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('buildEffectiveSystemPrompt', () => {
  test('returns default system prompt when no overrides', () => {
    const result = buildPrompt()
    expectPrompt(result, defaultPrompt)
  })

  test('defers local compression and style prompts to OmniRoute for CCB', () => {
    process.env.CCB_ENV = '1'
    const result = buildPrompt()
    const prompt = Array.from(result).join('\n')
    expect(prompt).toBe('You are a helpful assistant.\nFollow instructions.')
  })

  test('keeps local compression and style fallback when server routing is disabled', () => {
    process.env.CCB_ENV = '1'
    process.env.OMNIROUTE_SERVER_ROUTING = '0'
    const prompt = Array.from(buildPrompt()).join('\n')
    expect(prompt).toContain(
      'You are a helpful assistant.\nFollow instructions.',
    )
    if (feature('CAVEMAN')) {
      expect(prompt).toContain('CAVEMAN MODE ACTIVE')
    }
    if (feature('PONYTAIL')) {
      expect(prompt).toContain('PONYTAIL MODE ACTIVE')
    }
    if (feature('RTK')) {
      expect(prompt).toContain('[rtk-compact]')
    }
  })

  test('advisor model receives workflow delegation instructions', () => {
    const result = buildPrompt({
      toolUseContext: { options: { mainLoopModel: 'advisor' } as any },
    })
    expect(Array.from(result).join('\n')).toContain('mode="advisor"')
  })

  test('overrideSystemPrompt replaces everything', () => {
    const result = buildPrompt({ overrideSystemPrompt: 'override' })
    expectPrompt(result, ['override'])
  })

  test('customSystemPrompt replaces default', () => {
    const result = buildPrompt({ customSystemPrompt: 'custom' })
    expectPrompt(result, ['custom'])
  })

  test('appendSystemPrompt is appended after main prompt', () => {
    const result = buildPrompt({ appendSystemPrompt: 'appended' })
    expectPrompt(result, [...defaultPrompt, 'appended'])
  })

  test('agent definition replaces default prompt', () => {
    const agentDef = {
      getSystemPrompt: () => 'agent prompt',
      agentType: 'custom',
    } as any
    const result = buildPrompt({ mainThreadAgentDefinition: agentDef })
    expectPrompt(result, ['agent prompt'])
  })

  test('agent definition with append combines both', () => {
    const agentDef = {
      getSystemPrompt: () => 'agent prompt',
      agentType: 'custom',
    } as any
    const result = buildPrompt({
      mainThreadAgentDefinition: agentDef,
      appendSystemPrompt: 'extra',
    })
    expectPrompt(result, ['agent prompt', 'extra'])
  })

  test('override takes precedence over agent and custom', () => {
    const agentDef = {
      getSystemPrompt: () => 'agent prompt',
      agentType: 'custom',
    } as any
    const result = buildPrompt({
      mainThreadAgentDefinition: agentDef,
      customSystemPrompt: 'custom',
      appendSystemPrompt: 'extra',
      overrideSystemPrompt: 'override',
    })
    expectPrompt(result, ['override'])
  })

  test('returns array of strings', () => {
    const result = buildPrompt()
    expect(Array.isArray(result)).toBe(true)
    for (const item of result) {
      expect(typeof item).toBe('string')
    }
  })

  test('custom + append combines both', () => {
    const result = buildPrompt({
      customSystemPrompt: 'custom',
      appendSystemPrompt: 'extra',
    })
    expectPrompt(result, ['custom', 'extra'])
  })
})
