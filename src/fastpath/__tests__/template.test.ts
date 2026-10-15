import { test, expect } from 'bun:test'
import { render, missingVars } from '../template'

test('render substitutes simple variables', () => {
  expect(render('Hi {{name}}', { name: 'Ada' })).toBe('Hi Ada')
})

test('render resolves dotted paths and nested objects', () => {
  expect(render('{{user.email}}', { user: { email: 'a@b.io' } })).toBe('a@b.io')
})

test('render handles conditional blocks (truthy and falsy)', () => {
  const t = 'A{%if flag%}X{%endif%}B'
  expect(render(t, { flag: true })).toBe('AXB')
  expect(render(t, {})).toBe('AB')
})

test('missingVars lists unset names', () => {
  // source: missingVars uses matchAll per pattern separately; order follows template order for {{}}
  const t = '{{a}} {%if b%}z{%endif%} {{c}}'
  const r = missingVars(t, { a: 1 })
  expect(r).toContain('b')
  expect(r).toContain('c')
  expect(r).not.toContain('a')
})
