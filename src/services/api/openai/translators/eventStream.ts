/**
 * Minimal AWS EventStream (binary) codec — the wire format used by Kiro's
 * `generateAssistantResponse` endpoint (Accept: application/vnd.amazon.eventstream).
 *
 * Frame layout (all multi-byte integers big-endian):
 *   [0..4)  totalLength          (prelude)
 *   [4..8)  headersLength         (prelude)
 *   [8..12) prelude CRC32          (crc32 of the first 8 bytes)
 *   [12..12+headersLength) headers (name/type/value tuples)
 *   [..totalLength-4)             payload (opaque bytes, usually JSON)
 *   [totalLength-4..totalLength)  message CRC32 (crc32 of bytes [0, totalLength-4))
 *
 * Ported from 9router's kiro executor (executors/kiro.js) so claude-code's race
 * pool can speak Kiro's native protocol without a local gateway. The CRC32 and
 * frame parsing are pure and unit-tested (see eventStream.test.ts).
 */

export const EVENTSTREAM_MAX_MESSAGE_BYTES = 24 * 1024 * 1024
export const EVENTSTREAM_MAX_HEADERS_BYTES = 128 * 1024

const CRC32_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit++) {
    value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0)
  }
  return value >>> 0
})

/** Standard CRC-32 (IEEE 802.3), matching AWS EventStream's checksum. */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

export interface EventStreamEvent {
  headers: Record<string, unknown>
  payload: Record<string, unknown> | null
}

/**
 * Decode a single, complete AWS EventStream frame.
 * Throws on length/CRC/header violations so callers can surface a clean error.
 */
export function parseEventFrame(data: Uint8Array): EventStreamEvent {
  if (!(data instanceof Uint8Array) || data.byteLength < 16) {
    throw new Error('AWS EventStream frame is shorter than 16 bytes')
  }
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const totalLength = view.getUint32(0, false)
  const headersLength = view.getUint32(4, false)
  if (totalLength !== data.byteLength) {
    throw new Error('AWS EventStream frame length does not match its prelude')
  }
  if (
    totalLength > EVENTSTREAM_MAX_MESSAGE_BYTES ||
    headersLength > EVENTSTREAM_MAX_HEADERS_BYTES ||
    headersLength > totalLength - 16
  ) {
    throw new Error('AWS EventStream frame bounds are invalid')
  }
  if (view.getUint32(8, false) !== crc32(data.subarray(0, 8))) {
    throw new Error('AWS EventStream prelude CRC mismatch')
  }
  if (
    view.getUint32(totalLength - 4, false) !==
    crc32(data.subarray(0, totalLength - 4))
  ) {
    throw new Error('AWS EventStream message CRC mismatch')
  }

  const headers: Record<string, unknown> = Object.create(null)
  const names = new Set<string>()
  let offset = 12
  const headerEnd = offset + headersLength
  const requireBytes = (count: number) => {
    if (offset + count > headerEnd) {
      throw new Error('AWS EventStream header exceeds its declared bounds')
    }
  }

  while (offset < headerEnd) {
    requireBytes(1)
    const nameLength = data[offset++]
    requireBytes(nameLength + 1)
    const name = new TextDecoder().decode(
      data.subarray(offset, offset + nameLength),
    )
    offset += nameLength
    if (names.has(name))
      throw new Error(`AWS EventStream contains duplicate header: ${name}`)
    names.add(name)
    const type = data[offset++]

    if (type === 0 || type === 1) {
      headers[name] = type === 0
    } else if (type === 2) {
      requireBytes(1)
      headers[name] = view.getInt8(offset)
      offset += 1
    } else if (type === 3) {
      requireBytes(2)
      headers[name] = view.getInt16(offset, false)
      offset += 2
    } else if (type === 4) {
      requireBytes(4)
      headers[name] = view.getInt32(offset, false)
      offset += 4
    } else if (type === 5 || type === 8) {
      requireBytes(8)
      offset += 8
    } else if (type === 6 || type === 7) {
      requireBytes(2)
      const valueLength = view.getUint16(offset, false)
      offset += 2
      requireBytes(valueLength)
      const bytes = data.subarray(offset, offset + valueLength)
      headers[name] = type === 7 ? new TextDecoder().decode(bytes) : bytes
      offset += valueLength
    } else if (type === 9) {
      requireBytes(16)
      offset += 16
    } else {
      throw new Error(`AWS EventStream header ${name} has unknown type ${type}`)
    }
  }

  const payloadBytes = data.subarray(headerEnd, totalLength - 4)
  if (payloadBytes.byteLength === 0) return { headers, payload: null }
  const payloadText = new TextDecoder().decode(payloadBytes)
  if (!payloadText.trim()) return { headers, payload: null }
  try {
    return {
      headers,
      payload: JSON.parse(payloadText) as Record<string, unknown>,
    }
  } catch (error) {
    throw new Error(
      `AWS EventStream payload is not valid JSON (${(error as Error).message})`,
    )
  }
}

const encoder = new TextEncoder()

/**
 * Build a single AWS EventStream frame (used by tests and by any future
 * request-side encoding). Headers must be { name: { type, value } } where type
 * matches the on-wire codes used by parseEventFrame.
 */
export function buildEventFrame(
  headers: Array<{ name: string; type: number; value: unknown }>,
  payload: Record<string, unknown> | null,
): Uint8Array {
  const enc = new TextEncoder()
  const headerParts: Uint8Array[] = []
  for (const { name, type, value } of headers) {
    const nameBytes = enc.encode(name)
    const nameLen = new Uint8Array([nameBytes.byteLength])
    const typeByte = new Uint8Array([type])
    if (type === 0 || type === 1) {
      headerParts.push(nameLen, nameBytes, typeByte)
    } else if (type === 7) {
      const v = enc.encode(String(value))
      const len = new Uint8Array(2)
      new DataView(len.buffer).setUint16(0, v.byteLength, false)
      headerParts.push(nameLen, nameBytes, typeByte, len, v)
    } else {
      throw new Error(`buildEventFrame: unsupported header type ${type}`)
    }
  }
  const headerBlob = concatBytes(headerParts)
  const payloadBytes = payload
    ? enc.encode(JSON.stringify(payload))
    : new Uint8Array(0)

  const totalLength = 12 + headerBlob.byteLength + payloadBytes.byteLength + 4
  const frame = new Uint8Array(totalLength)
  const view = new DataView(frame.buffer)
  view.setUint32(0, totalLength, false)
  view.setUint32(4, headerBlob.byteLength, false)
  view.setUint32(8, crc32(frame.subarray(0, 8)), false)
  frame.set(headerBlob, 12)
  if (payloadBytes.byteLength)
    frame.set(payloadBytes, 12 + headerBlob.byteLength)
  view.setUint32(
    totalLength - 4,
    crc32(frame.subarray(0, totalLength - 4)),
    false,
  )
  return frame
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.byteLength, 0)
  const out = new Uint8Array(total)
  let off = 0
  for (const c of chunks) {
    out.set(c, off)
    off += c.byteLength
  }
  return out
}

export { encoder }
