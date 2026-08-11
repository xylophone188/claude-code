import { describe, it, expect } from 'bun:test'
import { detectLang, normalizeForRouting, isCJK } from '../translator.js'

describe('ccbRouting/translator', () => {
  it('detectLang returns zh for CJK-heavy text', () => {
    expect(detectLang('你好，世界！这是一段中文。')).toBe('zh')
  })

  it('detectLang returns en for ASCII-letter text', () => {
    expect(detectLang('Hello world, this is a plain English sentence.')).toBe(
      'en',
    )
  })

  it('detectLang returns other for empty/mixed/non-cjk text', () => {
    expect(detectLang('')).toBe('other')
    expect(detectLang('   \n  ')).toBe('other')
    expect(detectLang('123456 @#$% ^&*()')).toBe('other')
  })

  it('isCJK identifies CJK characters', () => {
    expect(isCJK('中')).toBe(true)
    expect(isCJK('abc')).toBe(false)
    expect(isCJK('')).toBe(false)
  })

  it('normalizeForRouting collapses whitespace and trims', () => {
    expect(normalizeForRouting('  hello   \n\t world  ')).toBe('hello world')
  })

  it('normalizeForRouting strips fenced code blocks', () => {
    expect(normalizeForRouting('use this ```const x = 1;``` ok?')).toBe(
      'use this ok?',
    )
  })
})
