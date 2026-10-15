import { test, expect } from 'bun:test'
import * as p from '../pattern'

test('matchUUID extracts canonical UUID', () => {
  const r = p.matchUUID('id=550e8400-e29b-41d4-a716-446655440000 and 1234')
  expect(r.ok).toBe(true)
  expect(r.matches).toEqual(['550e8400-e29b-41d4-a716-446655440000'])
  expect(r.dt).toBeGreaterThanOrEqual(0)
})

test('matchURL handles http and https', () => {
  const r = p.matchURL('see https://a.com/x and http://b.io/y')
  expect(r.matches).toContain('https://a.com/x')
  expect(r.matches).toContain('http://b.io/y')
})

test('matchVersion matches semver (with or without v)', () => {
  expect(p.matchVersion('version 1.2.3 here').matches).toEqual(['1.2.3'])
  expect(p.matchVersion('v10.0.0-rc1').matches).toEqual(['v10.0.0-rc1'])
})

test('matchHex handles 0x and # forms', () => {
  expect(p.matchHex('0xff #abc #aabbcc').matches).toEqual([
    '0xff',
    '#abc',
    '#aabbcc',
  ])
})

test('matchEmail + matchDate extract expected forms', () => {
  expect(p.matchEmail('contact bob@example.com today').matches).toEqual([
    'bob@example.com',
  ])
  expect(p.matchDate('2026-09-25 and 2026/09/25').matches).toEqual([
    '2026-09-25',
    '2026/09/25',
  ])
})

test('firstMatch returns first non-empty pattern', () => {
  const r = p.firstMatch('hello 550e8400-e29b-41d4-a716-446655440000')
  expect(r.matches.length).toBeGreaterThan(0)
})
