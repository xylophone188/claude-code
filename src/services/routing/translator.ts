/**
 * ccbRouting / translator — lightweight cross-lingual detection + normalization.
 *
 * Pure heuristics used to bias cross-lingual routing (e.g. prefer a model with
 * strong zh capability when the prompt is CJK-heavy). No network, no I/O, no
 * global state — safe to call anywhere in the routing pipeline.
 */

/** Script tag for a chunk of text. */
export type LangTag = 'zh' | 'en' | 'other'

/**
 * Test whether a single character (or a short run of text) is CJK.
 * Covers the major Unified Ideographs + common CJK punctuation ranges.
 */
export function isCJK(charOrText: string): boolean {
  if (!charOrText) return false
  for (const ch of charOrText) {
    const cp = ch.codePointAt(0) ?? 0
    // CJK Unified Ideographs, Ext A/B, Compatibility, plus common CJK punctuation.
    const cjk =
      (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified Ideographs
      (cp >= 0x3400 && cp <= 0x4dbf) || // Ext A
      (cp >= 0x20000 && cp <= 0x2a6df) || // Ext B
      (cp >= 0x3000 && cp <= 0x303f) || // CJK symbols & punctuation
      (cp >= 0xff00 && cp <= 0xffef) // Fullwidth forms
    if (!cjk) return false
  }
  return true
}

/**
 * Detect the dominant script of a piece of text.
 *   - 'zh'   : a meaningful fraction (>= 20%) of the text's characters are CJK.
 *   - 'en'   : mostly ASCII letters (>= 60% of non-space chars are [a-zA-Z]).
 *   - 'other': anything else (mixed, or dominated by non-CJK/non-ASCII letters).
 */
export function detectLang(text: string): LangTag {
  if (!text || !text.trim()) return 'other'

  let cjk = 0
  let asciiLetters = 0
  let total = 0
  for (const ch of text) {
    if (ch === '\n' || ch === '\r' || ch === '\t' || ch === ' ') continue
    total++
    const cp = ch.codePointAt(0) ?? 0
    if (
      (cp >= 0x4e00 && cp <= 0x9fff) ||
      (cp >= 0x3400 && cp <= 0x4dbf) ||
      (cp >= 0x20000 && cp <= 0x2a6df)
    ) {
      cjk++
    } else if ((cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a)) {
      asciiLetters++
    }
  }

  if (total === 0) return 'other'
  if (cjk / total >= 0.2) return 'zh'
  if (asciiLetters / total >= 0.6) return 'en'
  return 'other'
}

/**
 * Normalize text for routing decisions.
 *   - trim leading/trailing whitespace
 *   - collapse internal runs of whitespace (incl. newlines) to a single space
 *   - strip fenced code blocks (```...```) which carry little routing signal
 *
 * Pure: input is never mutated.
 */
export function normalizeForRouting(text: string): string {
  if (!text) return ''
  // Drop code fences and their content (weak routing signal, noisy).
  const stripped = text.replace(/```[\s\S]*?```/g, ' ')
  // Collapse all whitespace runs to a single space, then trim.
  return stripped.replace(/\s+/g, ' ').trim()
}
