import { test, expect } from 'bun:test'
import {
  jsonSchemaValidate,
  typeOf,
  assertType,
  assertValid,
} from '../validate'

test('typeOf distinguishes integer vs number', () => {
  expect(typeOf(1)).toBe('integer')
  expect(typeOf(1.5)).toBe('number')
  expect(typeOf([])).toBe('array')
  expect(typeOf(null)).toBe('null')
  expect(typeOf({})).toBe('object')
})

test('jsonSchemaValidate accepts matching object', () => {
  const r = jsonSchemaValidate(
    { type: 'object', required: ['a'], properties: { a: { type: 'string' } } },
    { a: 'x' },
  )
  expect(r.valid).toBe(true)
})

test('jsonSchemaValidate rejects missing required + wrong type', () => {
  const r = jsonSchemaValidate(
    { type: 'object', required: ['a'], properties: { a: { type: 'string' } } },
    { a: 5 },
  )
  expect(r.valid).toBe(false)
  expect(r.errors.join(' ')).toMatch(/required|expected string/)
})

test('assertType throws on mismatch, passes on match', () => {
  expect(() => assertType(1, 'string')).toThrow()
  expect(() => assertType(1, 'number')).not.toThrow()
  expect(() => assertType(1, 'integer')).not.toThrow()
})
