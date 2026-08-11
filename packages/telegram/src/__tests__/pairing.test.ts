import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const testDir = mkdtempSync(join(tmpdir(), 'telegram-test-pairing-'))
process.env.TELEGRAM_STATE_DIR = testDir

import {
  addPendingPairing,
  confirmPairing,
  isAllowed,
  loadAccessConfig,
  saveAccessConfig,
} from '../pairing.js'

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true })
})

describe('loadAccessConfig', () => {
  test('returns default config no file exists', () => {
    const config = loadAccessConfig()
    expect(config.policy).toBe('pairing')
    expect(config.allowFrom).toEqual([])
  })

  test('round-trips saved config', () => {
    saveAccessConfig({ policy: 'allowlist', allowFrom: ['user1'] })
    const config = loadAccessConfig()
    expect(config.policy).toBe('allowlist')
    expect(config.allowFrom).toEqual(['user1'])
  })
})

describe('isAllowed', () => {
  test('returns false unknown user under pairing policy', () => {
    expect(isAllowed('unknown')).toBe(false)
  })

  test('returns true allowed user', () => {
    saveAccessConfig({ policy: 'pairing', allowFrom: ['user1'] })
    expect(isAllowed('user1')).toBe(true)
  })

  test('returns true any user under disabled policy', () => {
    saveAccessConfig({ policy: 'disabled', allowFrom: [] })
    expect(isAllowed('anyone')).toBe(true)
  })

  test('supports @username identifiers', () => {
    saveAccessConfig({ policy: 'allowlist', allowFrom: ['@myuser'] })
    expect(isAllowed('@myuser')).toBe(true)
    expect(isAllowed('myuser')).toBe(false)
  })
})

describe('pairing flow', () => {
  test('generates 6-digit code', () => {
    expect(addPendingPairing('user1')).toMatch(/^\d{6}$/)
  })

  test('returns same code for same user', () => {
    const code1 = addPendingPairing('user1')
    const code2 = addPendingPairing('user1')
    expect(code1).toBe(code2)
  })

  test('confirm adds user to allowlist', () => {
    const code = addPendingPairing('user1')
    expect(confirmPairing(code)).toBe('user1')
    expect(isAllowed('user1')).toBe(true)
  })

  test('confirm returns null for invalid code', () => {
    expect(confirmPairing('000000')).toBeNull()
  })

  test('code cannot be reused after confirmation', () => {
    const code = addPendingPairing('user1')
    confirmPairing(code)
    expect(confirmPairing(code)).toBeNull()
  })

  test('expired code returns null', () => {
    const code = addPendingPairing('user1')
    const pendingPath = join(testDir, 'pending-pairings.json')
    const pending = JSON.parse(readFileSync(pendingPath, 'utf-8'))
    pending[code].expiresAt = Date.now() - 1000
    writeFileSync(pendingPath, JSON.stringify(pending))
    expect(confirmPairing(code)).toBeNull()
  })
})
