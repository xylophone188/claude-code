import { describe, test, expect } from 'bun:test'
import { crc32, parseEventFrame, buildEventFrame } from '../eventStream.js'

describe('crc32', () => {
  test('matches the standard CRC-32 check value for "123456789"', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926)
  })

  test('is stable and order-sensitive', () => {
    expect(crc32(new TextEncoder().encode('hello'))).not.toBe(
      crc32(new TextEncoder().encode('world')),
    )
    expect(crc32(new Uint8Array([0, 0, 0, 0]))).toBe(0x2144df1c)
  })
})

describe('parseEventFrame', () => {
  test('decodes a well-formed frame with a string header + JSON payload', () => {
    const frame = buildEventFrame(
      [{ name: ':event-type', type: 7, value: 'assistantResponseEvent' }],
      { content: 'hi' },
    )
    const event = parseEventFrame(frame)
    expect(event.headers[':event-type']).toBe('assistantResponseEvent')
    expect(event.payload).toEqual({ content: 'hi' })
  })

  test('returns null payload for an empty payload', () => {
    const frame = buildEventFrame(
      [{ name: ':event-type', type: 7, value: 'messageStopEvent' }],
      null,
    )
    const event = parseEventFrame(frame)
    expect(event.payload).toBeNull()
  })

  test('throws on prelude CRC mismatch', () => {
    const frame = buildEventFrame(
      [{ name: ':event-type', type: 7, value: 'x' }],
      { a: 1 },
    )
    // Corrupt a byte inside the prelude CRC (bytes 8..11) without touching the
    // length fields, so the length check passes but the CRC check fails.
    frame[8] ^= 0xff
    expect(() => parseEventFrame(frame)).toThrow(/prelude CRC mismatch/)
  })

  test('throws on message CRC mismatch', () => {
    const frame = buildEventFrame(
      [{ name: ':event-type', type: 7, value: 'x' }],
      { a: 1 },
    )
    // Corrupt a byte in the payload region (after the headers).
    frame[frame.byteLength - 5] ^= 0xff
    expect(() => parseEventFrame(frame)).toThrow(/message CRC mismatch/)
  })

  test('throws on a frame shorter than 16 bytes', () => {
    expect(() => parseEventFrame(new Uint8Array([1, 2, 3]))).toThrow(
      /shorter than 16/,
    )
  })
})
