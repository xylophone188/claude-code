import { describe, expect, test } from 'bun:test'
import { markdownToPlainText } from '../send.js'

describe('markdownToPlainText', () => {
  test('strips code block fences', () => {
    expect(markdownToPlainText('```js\ncode\n```')).toBe('code')
  })
  test('strips inline code', () => {
    expect(markdownToPlainText('`code`')).toBe('code')
  })
  test('strips bold', () => {
    expect(markdownToPlainText('**bold**')).toBe('bold')
  })
  test('strips italic', () => {
    expect(markdownToPlainText('*italic*')).toBe('italic')
  })
  test('strips links', () => {
    expect(markdownToPlainText('[link](url)')).toBe('link (url)')
  })
  test('keeps content around fenced block', () => {
    expect(markdownToPlainText('text\n```js\ncode\n```\nmore')).toBe(
      'text\ncode\nmore',
    )
  })
})
