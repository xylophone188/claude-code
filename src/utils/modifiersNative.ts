export type ModifierKey = 'shift' | 'command' | 'control' | 'option'

/**
 * Pre-warm the native modifier module.
 */
export async function prewarmNative(): Promise<void> {
  const { prewarm } = await import('modifiers-napi')
  await prewarm()
}

/**
 * Read the current state of a modifier key from the native module.
 */
export function isNativeModifierPressed(modifier: ModifierKey): boolean {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { isModifierPressed } = require('modifiers-napi') as {
    isModifierPressed: (m: string) => boolean
  }
  return isModifierPressed(modifier)
}
