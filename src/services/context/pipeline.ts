// CompressionPipeline — orchestrates CCB's embedded compression steps.
// ccb without taking a hard dependency on the (possibly absent) helper modules
// `cacheAlign.ts` / `compress.ts`. Those steps are implemented as inline PURE
// fallbacks here so the pipeline is fully testable with no spawned processes.
//
// Pipeline order:
//   step 1 (default on)  : align cache blocks   -> cacheAlign fallback
//   step 2 (if budget)   : trimToBudget          -> compress.ts fallback
//   step 3 (opt-in)      : manager.compress()    -> injected in-process hook
//
// Every step returns NEW arrays/objects; the caller's input is never mutated.

export interface PipelineStats {
  inputTokens: number
  outputTokens: number
  steps: string[]
}

export interface CompressionPipelineOptions {
  manager?: { compress: (messages: unknown) => Promise<unknown> }
  budgetTokens?: number
  useCacheAlign?: boolean
  useCompress?: boolean
}

export type PipelineMessage = { role: string; content: string }

/** Pure, dependency-free token estimate (heuristic ~4 chars/token). */
function estimateTokens(text: string): number {
  if (!text) return 1
  return Math.max(1, Math.ceil(text.length / 4))
}

function countTokens(messages: PipelineMessage[]): number {
  return messages.reduce((sum, m) => sum + estimateTokens(m.content), 0)
}

function clone(messages: PipelineMessage[]): PipelineMessage[] {
  return messages.map(m => ({ role: m.role, content: m.content }))
}

/**
 * Inline cache-alignment fallback. Providers benefit from fewer, stable cache
 * blocks, so we coalesce runs of consecutive messages with the same role into a
 * single block (joined by a blank line). Returns a brand-new array.
 */
function alignCacheBlocks(messages: PipelineMessage[]): PipelineMessage[] {
  const out: PipelineMessage[] = []
  for (const m of messages) {
    const last = out[out.length - 1]
    if (last && last.role === m.role) {
      last.content = `${last.content}\n\n${m.content}`
    } else {
      out.push({ role: m.role, content: m.content })
    }
  }
  return out
}

/**
 * Inline budget-trim fallback. Drops the OLDEST messages first until the total
 * token count fits `budget`, always keeping the most recent message. Returns a
 * brand-new array.
 */
function trimToBudget(
  messages: PipelineMessage[],
  budget: number,
): PipelineMessage[] {
  const result = clone(messages)
  while (result.length > 1 && countTokens(result) > budget) {
    result.shift()
  }
  return result
}

export class CompressionPipeline {
  private readonly manager?: CompressionPipelineOptions['manager']
  private readonly budgetTokens?: number
  private readonly useCacheAlign: boolean
  private readonly useCompress: boolean

  constructor(opts: CompressionPipelineOptions = {}) {
    this.manager = opts.manager
    this.budgetTokens = opts.budgetTokens
    this.useCacheAlign = opts.useCacheAlign ?? true
    this.useCompress = opts.useCompress ?? false
  }

  async run(
    messages: PipelineMessage[],
  ): Promise<{ messages: PipelineMessage[]; stats: PipelineStats }> {
    const inputTokens = countTokens(messages)
    const steps: string[] = []

    // step 1: align cache blocks (pure, default on)
    let working = clone(messages)
    if (this.useCacheAlign) {
      working = alignCacheBlocks(working)
      steps.push('cache-align')
    }

    // step 2: trim to budget (pure, only when a budget is configured)
    if (typeof this.budgetTokens === 'number' && this.budgetTokens > 0) {
      working = trimToBudget(working, this.budgetTokens)
      steps.push('trim-to-budget')
    }

    // step 3: optional in-process compression hook
    if (this.manager && this.useCompress) {
      const compressed = (await this.manager.compress(
        working,
      )) as PipelineMessage[]
      working = Array.isArray(compressed)
        ? compressed.map(m => ({ ...m }))
        : working
      steps.push('compress')
    }

    const outputTokens = countTokens(working)

    return {
      messages: working,
      stats: { inputTokens, outputTokens, steps },
    }
  }
}

export default CompressionPipeline
