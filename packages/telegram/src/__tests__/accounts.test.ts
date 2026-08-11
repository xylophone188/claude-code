import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const testDir = mkdtempSync(join(tmpdir(), 'telegram-test-accounts-'))
process.env.TELEGRAM_STATE_DIR = testDir

import { loadAccount, saveAccount, clearAccount } from '../accounts.js'

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true })
})

describe('account management', () => {
  test('loadAccount returns null when no file', () => {
    expect(loadAccount()).toBeNull()
  })

  test('saveAccount round-trips', () => {
    saveAccount({ token: '123:ABC', savedAt: '2024-01-01T00:00:00.000Z' })
    const loaded = loadAccount()
    expect(loaded?.token).toBe('123:ABC')
  })

  test('clearAccount removes file', () => {
    saveAccount({ token: '123:ABC', savedAt: '2024-01-01T00:00:00.000Z' })
    clearAccount()
    expect(loadAccount()).toBeNull()
  })

  test('file permissions are 0600', () => {
    saveAccount({ token: '123:ABC', savedAt: '2024-01-01T00:00:00.000Z' })
    const { statSync } = require('node:fs')
    const mode = statSync(join(testDir, 'account.json')).mode & 0o777
    expect(mode).toBe(0o600)
  })
})
