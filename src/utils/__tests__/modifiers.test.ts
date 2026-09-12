import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

let nativePrewarmCalls = 0
let nativeReturnValue = false
let nativeShouldThrow = false

const nativeIsModifierPressed = mock((modifier: string) => {
  if (nativeShouldThrow) {
    throw new Error('native modifier failure')
  }
  return nativeReturnValue
})

// Mock the local seam, NOT the `modifiers-napi` package specifier: the
// modifiers-napi package's own tests import the same workspace module and a
// process-global `mock.module('modifiers-napi')` here would hijack them.
// `../modifiersNative.ts` resolves to the same file `modifiers.ts` imports,
// so the stub applies to the wrapper without touching the package.
mock.module('../modifiersNative.ts', () => ({
  prewarmNative: async () => {
    nativePrewarmCalls++
  },
  isNativeModifierPressed: nativeIsModifierPressed,
}))

const originalPlatform = process.platform

async function loadModule() {
  return import(`../modifiers.ts?case=${Math.random()}`)
}

beforeEach(() => {
  nativePrewarmCalls = 0
  nativeReturnValue = false
  nativeShouldThrow = false
  nativeIsModifierPressed.mockClear()
  Object.defineProperty(process, 'platform', {
    value: originalPlatform,
    configurable: true,
  })
})

afterEach(() => {
  Object.defineProperty(process, 'platform', {
    value: originalPlatform,
    configurable: true,
  })
})

describe('src/utils/modifiers', () => {
  test('does not touch the native module on non-darwin', async () => {
    Object.defineProperty(process, 'platform', {
      value: 'win32',
      configurable: true,
    })
    const mod = await loadModule()

    mod.prewarmModifiers()
    expect(nativePrewarmCalls).toBe(0)
    expect(mod.isModifierPressed('shift')).toBe(false)
    expect(nativeIsModifierPressed).not.toHaveBeenCalled()
  })

  test('caches native prewarm after the first darwin call', async () => {
    Object.defineProperty(process, 'platform', {
      value: 'darwin',
      configurable: true,
    })
    const mod = await loadModule()

    mod.prewarmModifiers()
    mod.prewarmModifiers()

    // prewarm is fire-and-forget async — flush microtasks
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(nativePrewarmCalls).toBe(1)
  })

  test('forwards modifier checks to the native module on darwin', async () => {
    Object.defineProperty(process, 'platform', {
      value: 'darwin',
      configurable: true,
    })
    nativeReturnValue = true
    const mod = await loadModule()

    expect(mod.isModifierPressed('shift')).toBe(true)
    expect(nativeIsModifierPressed).toHaveBeenCalledWith('shift')
  })

  test('returns false when native modifier checks throw on darwin', async () => {
    Object.defineProperty(process, 'platform', {
      value: 'darwin',
      configurable: true,
    })
    nativeShouldThrow = true
    const mod = await loadModule()

    expect(mod.isModifierPressed('shift')).toBe(false)
  })
})
