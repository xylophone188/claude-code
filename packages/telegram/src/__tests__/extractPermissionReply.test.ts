import { describe, expect, test } from 'bun:test'
import { extractPermissionReply } from '../monitor.js'

describe('extractPermissionReply', () => {
  test('matches yes', () => {
    expect(extractPermissionReply('yes abcde')).toEqual({
      requestId: 'abcde',
      behavior: 'allow',
    })
  })
  test('matches y', () => {
    expect(extractPermissionReply('y abcde')).toEqual({
      requestId: 'abcde',
      behavior: 'allow',
    })
  })
  test('matches no', () => {
    expect(extractPermissionReply('no fghij')).toEqual({
      requestId: 'fghij',
      behavior: 'deny',
    })
  })
  test('matches n', () => {
    expect(extractPermissionReply('n fghij')).toEqual({
      requestId: 'fghij',
      behavior: 'deny',
    })
  })
  test('case insensitive', () => {
    expect(extractPermissionReply('YES ABCDE')).toEqual({
      requestId: 'abcde',
      behavior: 'allow',
    })
  })
  test('extra whitespace', () => {
    expect(extractPermissionReply('  yes   abcde  ')).toEqual({
      requestId: 'abcde',
      behavior: 'allow',
    })
  })
  test('returns null for non-matching', () => {
    expect(extractPermissionReply('maybe abcde')).toBeNull()
    expect(extractPermissionReply('yes')).toBeNull()
    expect(extractPermissionReply('')).toBeNull()
  })
})
