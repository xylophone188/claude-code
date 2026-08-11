/**
 * ccbRouting / stickyRoundRobin — stateful sticky round-robin selector.
 *
 * Wraps resolve.pickComboModel with persistent attempt state so callers get
 * consistent sticky behavior without tracking attempt numbers themselves.
 *
 * PURE: instance-local state only (no globals, no network, no DB).
 */
import type { CCBRoutingCombo } from './types.js'
import { pickComboModel, resolveModel } from './resolve.js'

/**
 * Stateful selector over a sticky-round-robin combo.
 *
 * A model stays "sticky" for `stickyLimit` consecutive `next()` calls before
 * rotating to the next model in the combo. `attempt` counts total calls made.
 */
export class StickyRoundRobin {
  private readonly combo: CCBRoutingCombo
  /** Number of `next()` calls made so far (0-based next attempt index). */
  public attempt = 0

  constructor(combo: CCBRoutingCombo) {
    this.combo = combo
  }

  /** Current model for the next attempt without advancing the counter. */
  peek(): string {
    return pickComboModel(this.combo, this.attempt) ?? ''
  }

  /** Returns the model for the current attempt, then advances `attempt`. */
  next(): string {
    const model = pickComboModel(this.combo, this.attempt) ?? ''
    this.attempt += 1
    return model
  }
}

/**
 * Build a StickyRoundRobin selector from a combo name.
 *
 * Returns undefined unless `name` resolves to a combo whose strategy is
 * 'sticky-round-robin' (e.g. "fast-rr"). Other strategies are not supported.
 */
export function fromComboName(name: string): StickyRoundRobin | undefined {
  const resolved = resolveModel(name)
  if (!resolved || !('combo' in resolved)) return undefined
  const combo = resolved.combo
  if (combo.strategy !== 'sticky-round-robin') return undefined
  return new StickyRoundRobin(combo)
}
