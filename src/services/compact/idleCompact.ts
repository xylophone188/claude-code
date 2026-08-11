/**
 * Idle-time preemptive compaction engine.
 *
 * Instead of waiting for autocompact to fire at the next user turn (which
 * happens after the user has already sent a message and is left waiting for
 * the LLM to compress the context), this module runs a background compaction
 * during the idle period after a turn completes.
 *
 * Score-based adaptive threshold:
 *   score = tokenRatio * 0.75 + toolDensity * 0.15 + outputGrowth * 0.10
 *
 *  tokenRatio  = current tokens / effective window (0..1)
 *  toolDensity = tool calls in last 2 turns, normalized to max 0.15 weight
 *  outputGrowth = avg tokens in recent assistant messages, normalized to 0.10
 *
 * Hard gate: score is forced to 0 when tokenRatio < MIN_TOKEN_RATIO, so heavy
 * tool use alone can never trigger compaction at low fill levels. This was the
 * root cause of "every tool call compresses" — toolDensity/outputGrowth could
 * push the score past threshold at 25% fill during agent tool loops.
 *
 * Env overrides:
 *   CCB_IDLE_COMPACT_ENABLED=0          - disable (default: on)
 *   CCB_IDLE_COMPACT_THRESHOLD_PCT=70   - score threshold 0-100 (default: 70)
 *   CCB_IDLE_COMPACT_MIN_IDLE_SECONDS=30 - idle wait before checking (default: 30)
 *   CCB_IDLE_COMPACT_MAX_IDLE_SECONDS=60 - max wait cap (default: 60)
 *   CCB_IDLE_COMPACT_MIN_TOKEN_RATIO=0.5 - hard floor on fill ratio (default: 0.5)
 */

import { getEffectiveContextWindowSize } from './autoCompact.js'
import { tokenCountWithEstimation } from '../../utils/tokens.js'
import type { Message } from '../../types/message.js'

type CompactTrigger = {
  messages: Message[]
  model: string
  canUseTool: (toolName: string) => boolean | Promise<boolean>
  abortSignal: AbortSignal
  onCompact: (messages: Message[]) => Promise<void>
}

const DEFAULT_IDLE_SECONDS = 45
const DEFAULT_THRESHOLD_PCT = 70
const DEFAULT_MAX_IDLE_SECONDS = 60
const DEFAULT_MIN_TOKEN_RATIO = 0.5
const WEIGHT_TOKEN_RATIO = 0.75
const WEIGHT_TOOL_DENSITY = 0.15
const WEIGHT_OUTPUT_GROWTH = 0.1

let currentTimerId: ReturnType<typeof setTimeout> | null = null

/** Count tool_use blocks in the last N assistant messages (for density signal). */
function countToolUseBlocks(messages: Message[], lastN: number): number {
  let count = 0
  let scanned = 0
  for (let i = messages.length - 1; i >= 0 && scanned < lastN; i--) {
    const msg = messages[i]
    if (msg?.type === 'assistant') {
      const content = msg.message?.content
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'tool_use') count++
        }
      }
      scanned++
    }
  }
  return count
}

/** Sum tokens from recent assistant message content (text + tool results). */
function recentAssistantTokenSum(messages: Message[], lastN: number): number {
  let sum = 0
  let scanned = 0
  for (let i = messages.length - 1; i >= 0 && scanned < lastN; i--) {
    const msg = messages[i]
    if (msg?.type === 'assistant') {
      const text =
        typeof msg.message?.content === 'string'
          ? msg.message.content
          : Array.isArray(msg.message?.content)
            ? (msg.message.content as Array<{ type: string; text?: string }>)
                .filter(b => b.type === 'text')
                .map(b => b.text ?? '')
                .join('')
            : ''
      // Rough char-to-token estimate: 4 chars per token is standard
      sum += text.length / 4
      scanned++
    }
  }
  return sum
}

/**
 * Calculate the idle compact decision score (0..1).
 * Higher = more urgent to compact.
 */
export function calculateIdleCompactScore(
  messages: Message[],
  model: string,
): number {
  if (messages.length === 0) return 0

  const currentTokens = tokenCountWithEstimation(messages)
  const effectiveWindow = getEffectiveContextWindowSize(model)
  if (effectiveWindow <= 0) return 0

  // tokenRatio: how full is the context?
  const tokenRatio = Math.min(currentTokens / effectiveWindow, 1)

  // Hard gate: never fire below the minimum fill ratio. Without this, a
  // tool-heavy agent loop (toolDensity=1, outputGrowth=1) could push the
  // score past threshold at ~25% fill, causing a compaction on every turn
  // even though the context is mostly empty.
  const minTokenRatio =
    Number(process.env.CCB_IDLE_COMPACT_MIN_TOKEN_RATIO) ||
    DEFAULT_MIN_TOKEN_RATIO
  if (tokenRatio < minTokenRatio) return 0

  // toolDensity: heavy tool use in recent turns = more state to compress
  const toolCalls = countToolUseBlocks(messages, 2)
  const toolDensity = Math.min(toolCalls / 8, 1)

  // outputGrowth: large recent assistant responses = context is growing fast
  const avgOutputTokens = recentAssistantTokenSum(messages, 2)
  const outputGrowth = Math.min(avgOutputTokens / 10_000, 1)

  return (
    tokenRatio * WEIGHT_TOKEN_RATIO +
    toolDensity * WEIGHT_TOOL_DENSITY +
    outputGrowth * WEIGHT_OUTPUT_GROWTH
  )
}

/**
 * Start the idle-compact timer.
 *
 * Fires after `idleSeconds` of user inactivity (since last turn completion).
 * If score > threshold, calls `onCompact(messages)` to perform background
 * compaction via a forked agent with skipCacheWrite=true (silent, no UI).
 *
 * Only one timer runs at a time; subsequent calls reset the timer.
 * The timer is aborted if `abortSignal` fires.
 */
export function startIdleCompactTimer(options: CompactTrigger): () => void {
  const enabled = process.env.CCB_IDLE_COMPACT_ENABLED !== '0'

  if (!enabled) {
    return () => {}
  }

  const idleSeconds =
    Number(process.env.CCB_IDLE_COMPACT_MIN_IDLE_SECONDS) ||
    DEFAULT_IDLE_SECONDS
  const thresholdPct =
    Number(process.env.CCB_IDLE_COMPACT_THRESHOLD_PCT) || DEFAULT_THRESHOLD_PCT
  const maxIdleSeconds =
    Number(process.env.CCB_IDLE_COMPACT_MAX_IDLE_SECONDS) ||
    DEFAULT_MAX_IDLE_SECONDS

  const threshold = thresholdPct / 100
  const minTokenRatio =
    Number(process.env.CCB_IDLE_COMPACT_MIN_TOKEN_RATIO) ||
    DEFAULT_MIN_TOKEN_RATIO

  // Cancel any existing timer
  if (currentTimerId !== null) {
    clearTimeout(currentTimerId)
    currentTimerId = null
  }

  const delayMs = Math.min(idleSeconds * 1000, maxIdleSeconds * 1000)

  currentTimerId = setTimeout(async () => {
    currentTimerId = null

    // Check abort signal
    if (options.abortSignal.aborted) return

    // Capture current state at timer fire time (not at timer start)
    const score = calculateIdleCompactScore(options.messages, options.model)
    const scorePct = Math.round(score * 100)

    // Log to debug channel (won't show in REPL UI)
    require('../../utils/debug.js').logForDebugging(
      `idleCompact: score=${scorePct}% threshold=${Math.round(threshold * 100)}% minTokenRatio=${minTokenRatio} messages=${options.messages.length} model=${options.model}`,
    )

    if (score >= threshold) {
      try {
        await options.onCompact(options.messages)
      } catch (err) {
        require('../../utils/log.js').logError(err)
      }
    }
  }, delayMs)

  // Return abort handler
  return () => {
    if (currentTimerId !== null) {
      clearTimeout(currentTimerId)
      currentTimerId = null
    }
  }
}

/**
 * Clear any pending idle-compact timer immediately.
 * Call this when a new turn starts (user submitted message).
 */
export function clearIdleCompactTimer(): void {
  if (currentTimerId !== null) {
    clearTimeout(currentTimerId)
    currentTimerId = null
  }
}
