// Pure compression-strategy helpers for CCB context processing.
//
// This module is a SEPARATE, dependency-free set of pure functions that
// No side effects, network, or provider ids.

export interface ChatMessage {
  role: string
  content: string
}

export interface CompressionStats {
  /** Token estimate of the input before compression. */
  inputTokens: number
  /** Token estimate of the output after compression. */
  outputTokens: number
  /** How many messages were retained. */
  retainedMessages: number
  /** How many messages were dropped. */
  droppedMessages: number
  /** Reduction ratio in [0,1]; 0 = no reduction, 1 = fully reduced. */
  reduction: number
}

/**
 * Cheap token approximation: ceiling of chars / 4.
 * Monotonic in input length.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/**
 * Drop oldest non-system messages until the summed token estimate is within
 * budget. System messages are always preserved, even if over budget.
 */
export function trimToBudget(
  messages: ChatMessage[],
  budgetTokens: number,
): ChatMessage[] {
  const system = messages.filter(m => m.role === 'system')
  const nonSystem = messages.filter(m => m.role !== 'system')

  let used = system.reduce((sum, m) => sum + estimateTokens(m.content), 0)

  const keptNewestFirst: ChatMessage[] = []
  // Drop oldest first: iterate newest -> oldest, keep while within budget.
  for (let i = nonSystem.length - 1; i >= 0; i--) {
    const cost = estimateTokens(nonSystem[i].content)
    if (used + cost > budgetTokens) break
    used += cost
    keptNewestFirst.push(nonSystem[i])
  }
  const kept = keptNewestFirst.reverse()

  // Preserve original ordering: system messages stay at their positions, but
  // semantically system prompts lead the conversation. Re-interleave by
  // keeping systems first (their position is generally head-of-thread).
  return [...system, ...kept]
}

const COMMON_STOP = '.!?。！？\n'

function splitSentences(text: string): string[] {
  if (!text.trim()) return []
  const parts = text.split(/[.!?。！？\n]+/).map(s => s.trim())
  return parts.filter(s => s.length > 0)
}

function keywordFrequency(text: string): Map<string, number> {
  const words = text
    .toLowerCase()
    .split(/\s+/)
    .filter(w => w.length >= 4)
  const freq = new Map<string, number>()
  for (const w of words) {
    freq.set(w, (freq.get(w) ?? 0) + 1)
  }
  return freq
}

function scoreSentence(sentence: string, freq: Map<string, number>): number {
  const lower = sentence.toLowerCase()
  let kw = 0
  for (const [word, count] of freq) {
    if (lower.includes(word)) kw += count
  }
  // Score: keyword relevance + a small length bonus (longer = more context).
  return kw + sentence.length / 200
}

/**
 * Extractive summarization: for each non-system message, keep the top `ratio`
 * fraction of its sentences by keyword-score, preserving original order.
 * System messages are passed through unchanged. Pure, no network.
 */
export function extractiveSummarize(
  messages: ChatMessage[],
  ratio = 0.5,
): ChatMessage[] {
  return messages.map(m => {
    if (m.role === 'system') return m

    const sentences = splitSentences(m.content)
    if (sentences.length <= 1) return m

    const freq = keywordFrequency(m.content)
    const scored = sentences.map(s => ({
      s,
      score: scoreSentence(s, freq),
    }))

    const keepCount = Math.max(1, Math.round(sentences.length * ratio))
    const ranked = [...scored].sort((a, b) => b.score - a.score)
    const chosen = new Set(ranked.slice(0, keepCount).map(r => r.s))
    const kept = scored.filter(r => chosen.has(r.s)).map(r => r.s)

    return { role: m.role, content: kept.join('. ') + '.' }
  })
}

/**
 * Convenience: compute reduction stats for a compress transformation.
 */
export function computeStats(
  before: ChatMessage[],
  after: ChatMessage[],
): CompressionStats {
  const inputTokens = before.reduce(
    (sum, m) => sum + estimateTokens(m.content),
    0,
  )
  const outputTokens = after.reduce(
    (sum, m) => sum + estimateTokens(m.content),
    0,
  )
  const beforeCount = before.length
  return {
    inputTokens,
    outputTokens,
    retainedMessages: after.length,
    droppedMessages: beforeCount - after.length,
    reduction: inputTokens === 0 ? 0 : 1 - outputTokens / inputTokens,
  }
}
