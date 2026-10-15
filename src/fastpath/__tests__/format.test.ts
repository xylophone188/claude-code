import { test, expect } from 'bun:test'
import { formatJson, formatYaml, formatMarkdown } from '../format'

test('formatJson parses string and re-serializes with indent', () => {
  const out = formatJson('{"a":1,"b":2}', 2)
  expect(out).toContain('"a": 1')
  expect(out).toContain('"b": 2')
})

test('formatYaml handles scalars, objects, arrays', () => {
  const out = formatYaml({ name: 'Ada', tags: ['a', 'b'] })
  expect(out).toContain('name: Ada')
  expect(out).toContain('tags:')
  expect(out).toContain('- a')
  expect(out).toContain('- b')
})

test('formatYaml quotes reserved/numeric strings', () => {
  const out = formatYaml({ v: 'true', n: '123', safe: 'hello' })
  expect(out).toContain('"true"')
  expect(out).toContain('"123"')
  expect(out).toContain('safe: hello')
})

test('formatMarkdown strips trailing whitespace and collapses 3+ blank lines', () => {
  const out = formatMarkdown('a  \nb\n\n\n\nc')
  expect(out).not.toMatch(/[ \t]+\n/)
  expect(out).not.toMatch(/\n{3,}/)
})
