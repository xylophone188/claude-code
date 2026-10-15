import { describe, expect, test } from 'bun:test'
import { canHandle, run, RULES, RULE_MAP } from '../index'

describe('fastpath/index dispatcher', () => {
  test('canHandle recognizes every rule prefix', () => {
    for (const rule of RULES) {
      expect(canHandle(`${rule.name} rest...`)).toBe(true)
    }
    expect(canHandle('translate this to french')).toBe(false)
    expect(canHandle('')).toBe(false)
  })

  test('run dispatches rename.pascal synchronously', async () => {
    const r = await run('rename.pascal some input text', ['some input text'])
    expect(r.ok).toBe(true)
    expect(r.result).toBe('SomeInputText')
  })

  test('run dispatches validate.typeOf', async () => {
    const r = await run('validate.typeOf', [[1, 2]])
    expect(r.ok).toBe(true)
    expect(r.result).toBe('array')
  })

  test('run dispatches match.uuid with PatternResult passthrough', async () => {
    const r = await run('match.uuid', [
      'id 550e8400-e29b-41d4-a716-446655440000',
    ])
    expect(r.ok).toBe(true)
    expect((r as unknown as { matches: string[] }).matches).toEqual([
      '550e8400-e29b-41d4-a716-446655440000',
    ])
  })

  test('run dispatches format.json', async () => {
    const r = await run('format.json {"a":1}', ['{"a":1}'])
    expect(r.ok).toBe(true)
    expect(r.result).toContain('"a": 1')
  })

  test('run on unknown prompt fails gracefully', async () => {
    const r = await run('frobnicate the widget')
    expect(r.ok).toBe(false)
    expect(r.error).toContain('no fastpath rule')
  })

  test('run catches thrown rule errors as ok:false', async () => {
    const r = await run('fs.read', ['/definitely/not/here.txt'])
    expect(r.ok).toBe(false)
    expect(r.error).toBeDefined()
  })

  test('RULE_MAP covers all rule names uniquely', () => {
    expect(RULE_MAP.size).toBe(RULES.length)
    for (const rule of RULES) expect(RULE_MAP.has(rule.name)).toBe(true)
  })
})
