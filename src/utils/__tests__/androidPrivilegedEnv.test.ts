import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import {
  isAndroidEnvironment,
  detectAndroidPrivilegedEnvironment,
  getAndroidPrivilegedEnvPrompt,
  resetCachedPrompt,
} from '../androidPrivilegedEnv.js'

describe('androidPrivilegedEnv', () => {
  const origPlatform = process.platform
  const origPrefix = process.env.PREFIX

  beforeEach(() => {
    resetCachedPrompt()
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: origPlatform })
    if (origPrefix === undefined) {
      delete process.env.PREFIX
    } else {
      process.env.PREFIX = origPrefix
    }
    resetCachedPrompt()
  })

  it('detects non-android environment correctly', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' })
    delete process.env.PREFIX
    expect(isAndroidEnvironment()).toBe(false)
    expect(getAndroidPrivilegedEnvPrompt()).toBeNull()
  })

  it('detects termux environment via PREFIX', () => {
    Object.defineProperty(process, 'platform', { value: 'linux' })
    process.env.PREFIX = '/data/data/com.termux/files/usr'
    expect(isAndroidEnvironment()).toBe(true)
    const prompt = getAndroidPrivilegedEnvPrompt()
    expect(prompt).not.toBeNull()
    expect(prompt).toContain('Android 特权环境提示')
  })

  it('detects android platform directly', () => {
    Object.defineProperty(process, 'platform', { value: 'android' })
    delete process.env.PREFIX
    expect(isAndroidEnvironment()).toBe(true)
    const prompt = getAndroidPrivilegedEnvPrompt()
    expect(prompt).not.toBeNull()
    expect(prompt).toContain('Android 特权环境提示')
  })
})
