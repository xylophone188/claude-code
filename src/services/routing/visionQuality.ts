/**
 * Vision-response semantics gate for routed completions.
 *
 * A successful HTTP status does not guarantee that a vision request produced
 * useful text. Some gateways return an image/data URL, a base64 blob, or an
 * image placeholder instead of the requested explanation.
 */

export type VisionQualityVerdict = 'ok' | 'reject'

export type VisionQualityReason =
  | 'ok'
  | 'empty'
  | 'image-only'
  | 'base64-only'
  | 'placeholder'
  | 'fake200'

export interface VisionQualityResult {
  verdict: VisionQualityVerdict
  reason: VisionQualityReason
  detail?: string
}

export interface VisionQualityConfig {
  minTextLength?: number
}

const DEFAULT_MIN_TEXT_LENGTH = 8
const DATA_URL_RE = /^data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=\s]+$/i
const BASE64_RE = /^[a-z0-9+/=\s]{64,}$/i
const IMAGE_PLACEHOLDER_RE =
  /^(?:\[?(?:image|图片|图像|视觉内容|image output|generated image)\]?|<image\s*\/?>)$/i
const IMAGE_MARKER_RE = /(?:^|\s)(?:\[image\]|<image\s*\/?>|image_url\s*:)/i

/** Reject response bodies that are not meaningful vision explanations. */
export function validateVisionResponse(
  text: string,
  config: VisionQualityConfig = {},
): VisionQualityResult {
  const compact = text.trim()
  if (!compact) return { verdict: 'reject', reason: 'empty' }

  if (DATA_URL_RE.test(compact)) {
    return { verdict: 'reject', reason: 'image-only', detail: 'image data URL' }
  }
  if (BASE64_RE.test(compact) && !/\s/.test(compact.slice(0, 64))) {
    return {
      verdict: 'reject',
      reason: 'base64-only',
      detail: 'base64 payload',
    }
  }
  if (IMAGE_PLACEHOLDER_RE.test(compact) || IMAGE_MARKER_RE.test(compact)) {
    return { verdict: 'reject', reason: 'placeholder' }
  }

  const minTextLength = config.minTextLength ?? DEFAULT_MIN_TEXT_LENGTH
  if (compact.length < minTextLength) {
    return {
      verdict: 'reject',
      reason: 'fake200',
      detail: 'vision response is too short to explain the image',
    }
  }

  return { verdict: 'ok', reason: 'ok' }
}

/** Whether a response is an image-only or placeholder fake success. */
export function isVisionFakeSuccess(text: string): boolean {
  return validateVisionResponse(text).verdict === 'reject'
}

/**
 * Detect whether a message payload contains vision/image input.
 *
 * Walks recursively: a top-level array of parts, a single part object,
 * or a nested `content` array. Recognizes the OpenAI `image_url` content
 * type and the Anthropic-style `input_image` field.
 */
export function containsVisionInput(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(containsVisionInput)
  }
  if (!value || typeof value !== 'object') return false
  const part = value as Record<string, unknown>
  if (part.type === 'image_url' || part.type === 'input_image') return true
  const imageUrl = part.image_url as { url?: unknown } | undefined
  if (imageUrl && typeof imageUrl.url === 'string') return true
  if (Array.isArray(part.content)) {
    return part.content.some(containsVisionInput)
  }
  return false
}
