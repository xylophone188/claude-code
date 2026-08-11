/**
 * accountFallback.ts
 *
 * Pure-TypeScript port of ccb's `accountFallback.js` account-fallback logic.
 *
 * The upstream module provides fallback across multiple API accounts/keys for the
 * same provider when one is rate-limited / over-quota (round-robin or sequential
 * retry). This port captures the core selection logic only, with NO network and
 * NO external dependencies — it is fully pure and dependency-free.
 */

/** A single API account/key slot for one provider. */
export interface AccountSlot {
  /** The API key / account token to use. */
  key: string
  /** Relative selection weight (reserved for future weighted round-robin). */
  weight?: number
  /** Whether the slot is currently healthy. Unhealthy slots are skipped. */
  healthy?: boolean
}

/**
 * Return the next healthy slot in round-robin order, skipping unhealthy slots
 * and wrapping around.
 *
 * @param slots - The ordered list of account slots.
 * @param lastIndex - The index used last time; the search starts after it.
 *                   Defaults to -1 so the first call returns the first healthy slot.
 * @returns The next healthy slot's index and key, or undefined if none are healthy.
 */
export function nextAccount(
  slots: AccountSlot[],
  lastIndex?: number,
): { index: number; key: string } | undefined {
  const n = slots.length
  if (n === 0) return undefined

  const start = lastIndex === undefined ? -1 : lastIndex
  for (let step = 1; step <= n; step++) {
    const idx = (start + step) % n
    const slot = slots[idx]
    if (slot && slot.healthy !== false) {
      return { index: idx, key: slot.key }
    }
  }
  return undefined
}

/**
 * Return a NEW array identical to `slots`, except the slot at `index` is marked
 * `healthy: false`. The input array is never mutated.
 *
 * @param slots - The slots array to copy.
 * @param index - The index of the slot to mark unhealthy.
 * @returns A new array with the target slot marked unhealthy.
 */
export function markUnhealthy(
  slots: AccountSlot[],
  index: number,
): AccountSlot[] {
  return slots.map((slot, i) =>
    i === index ? { ...slot, healthy: false } : slot,
  )
}
