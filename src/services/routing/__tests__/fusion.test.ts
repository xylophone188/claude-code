import { describe, expect, test } from 'bun:test'
import { fuseAnswers, scoreStructure, type PanelAnswer } from '../fusion.js'

const structured: PanelAnswer = {
  model: 'openai/gpt-5.4',
  text: [
    '# How to sort a list',
    '',
    'Use the built-in sort:',
    '',
    '```ts',
    'const xs = [3, 1, 2].sort((a, b) => a - b)',
    '```',
    '',
    '- Fast for small inputs',
    '- Stable in modern engines',
  ].join('\n'),
}

const plain: PanelAnswer = {
  model: 'xai/grok-4',
  text: 'you can sort a list by using the built-in sort function that orders the elements.',
}

const other: PanelAnswer = {
  model: 'kimi/kimi-k3',
  text: 'to sort just call the sort method on the array and it will order the elements for you.',
}

describe('scoreStructure', () => {
  test('structured text scores higher than plain text', () => {
    expect(scoreStructure(structured.text)).toBeGreaterThan(
      scoreStructure(plain.text),
    )
  })

  test('empty text scores zero', () => {
    expect(scoreStructure('')).toBe(0)
  })
})

describe('fuseAnswers', () => {
  test("'best' picks the most structured answer", () => {
    const out = fuseAnswers([plain, structured, other], 'best')
    expect(out).toBe(structured.text)
  })

  test("'concat' includes every model label and all texts", () => {
    const out = fuseAnswers([plain, structured], 'concat')
    expect(out).toContain('[xai/grok-4]:')
    expect(out).toContain('[openai/gpt-5.4]:')
    expect(out).toContain(plain.text)
    expect(out).toContain(structured.text)
  })

  test("'vote' picks the consensus answer", () => {
    // `plain` and `other` share vocabulary and form a consensus vs `structured`.
    const out = fuseAnswers([structured, plain, other], 'vote')
    expect(out === plain.text || out === other.text).toBe(true)
  })

  test("'vote' falls back to 'best' on a single or empty input", () => {
    expect(fuseAnswers([], 'vote')).toBe('')
    expect(fuseAnswers([structured], 'vote')).toBe(structured.text)
  })
})
