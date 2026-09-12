import { describe, expect, it } from 'bun:test'
import {
  containsVisionInput,
  isVisionFakeSuccess,
  validateVisionResponse,
} from '../visionQuality.js'

describe('validateVisionResponse', () => {
  it('accepts a meaningful vision explanation', () => {
    expect(
      validateVisionResponse('The image shows a cat sitting on a mat.'),
    ).toEqual({ verdict: 'ok', reason: 'ok' })
  })

  it('rejects an empty response', () => {
    expect(validateVisionResponse('').reason).toBe('empty')
    expect(validateVisionResponse('   ').reason).toBe('empty')
  })

  it('rejects a data URL returned as HTTP 200', () => {
    const dataUrl =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
    const result = validateVisionResponse(dataUrl)
    expect(result.verdict).toBe('reject')
    expect(result.reason).toBe('image-only')
  })

  it('rejects a base64 blob', () => {
    const blob =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
    const result = validateVisionResponse(blob)
    expect(result.verdict).toBe('reject')
    expect(result.reason).toBe('base64-only')
  })

  it('rejects image placeholder text', () => {
    expect(validateVisionResponse('[image]').reason).toBe('placeholder')
    expect(validateVisionResponse('<image />').reason).toBe('placeholder')
    expect(validateVisionResponse('图片').reason).toBe('placeholder')
    expect(validateVisionResponse('image output').reason).toBe('placeholder')
  })

  it('rejects very short text that is too little to be useful', () => {
    const result = validateVisionResponse('ok')
    expect(result.verdict).toBe('reject')
    expect(result.reason).toBe('fake200')
  })

  it('accepts text at or above the minimum length', () => {
    const text = 'The picture depicts a landscape.'
    expect(validateVisionResponse(text).verdict).toBe('ok')
  })
})

describe('isVisionFakeSuccess', () => {
  it('returns true for vision fake-200 shapes', () => {
    expect(isVisionFakeSuccess('data:image/png;base64,abc123')).toBe(true)
    expect(isVisionFakeSuccess('[image]')).toBe(true)
    expect(isVisionFakeSuccess('')).toBe(true)
  })

  it('returns false for valid explanations', () => {
    expect(isVisionFakeSuccess('A detailed description of the image.')).toBe(
      false,
    )
  })
})

describe('containsVisionInput', () => {
  it('detects an OpenAI image_url part at the top level', () => {
    const message = {
      role: 'user',
      content: [
        { type: 'text', text: 'What is in this picture?' },
        { type: 'image_url', image_url: { url: 'https://x/y.png' } },
      ],
    }
    expect(containsVisionInput(message)).toBe(true)
  })

  it('detects a message with a string image_url', () => {
    expect(
      containsVisionInput({
        type: 'image_url',
        image_url: 'data:image/png;base64,abc',
      }),
    ).toBe(true)
  })

  it('detects an Anthropic-style input_image part', () => {
    expect(
      containsVisionInput({ type: 'input_image', source: { type: 'base64' } }),
    ).toBe(true)
  })

  it('finds image parts nested inside a content array', () => {
    const message = {
      role: 'user',
      content: [
        {
          type: 'text',
          text: 'Look at this:',
          content: [
            { type: 'image_url', image_url: { url: 'https://x/y.png' } },
          ],
        },
      ],
    }
    expect(containsVisionInput(message)).toBe(true)
  })

  it('returns false for plain text messages', () => {
    const message = { role: 'user', content: 'Just some text.' }
    expect(containsVisionInput(message)).toBe(false)
    expect(containsVisionInput({ role: 'user', content: [] })).toBe(false)
  })

  it('returns false for string content arrays', () => {
    expect(containsVisionInput({ role: 'user', content: ['a', 'b'] })).toBe(
      false,
    )
  })

  it('returns false for nullish or primitive input', () => {
    expect(containsVisionInput(null)).toBe(false)
    expect(containsVisionInput(undefined)).toBe(false)
    expect(containsVisionInput('plain string')).toBe(false)
    expect(containsVisionInput(42)).toBe(false)
  })
})
