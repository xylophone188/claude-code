import type { ModifierKey } from './modifiersNative'
import { isNativeModifierPressed, prewarmNative } from './modifiersNative'

export type { ModifierKey }

let prewarmed = false

/**
 * Pre-warm the native module by loading it in advance.
 * Call this early to avoid delay on first use.
 */
export function prewarmModifiers(): void {
  if (prewarmed || process.platform !== 'darwin') {
    return
  }
  prewarmed = true
  void prewarmNative().catch(() => {})
}

/**
 * Check if a specific modifier key is currently pressed (synchronous).
 */
export function isModifierPressed(modifier: ModifierKey): boolean {
  if (process.platform !== 'darwin') {
    return false
  }
  try {
    return isNativeModifierPressed(modifier)
  } catch {
    return false
  }
}
