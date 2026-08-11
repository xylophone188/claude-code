import {
  existsSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  mkdirSync,
} from 'node:fs'
import { randomInt } from 'node:crypto'
import { join } from 'node:path'
import { getStateDir } from './accounts.js'

export interface AccessConfig {
  policy: 'pairing' | 'allowlist' | 'disabled'
  allowFrom: string[]
}

interface PendingEntry {
  userId: string
  expiresAt: number
}

function configPath(): string {
  return join(getStateDir(), 'access.json')
}

function pendingPath(): string {
  return join(getStateDir(), 'pending-pairings.json')
}

function loadPending(): Record<string, PendingEntry> {
  const path = pendingPath()
  if (!existsSync(path)) return {}
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as Record<
      string,
      PendingEntry
    >
  } catch {
    return {}
  }
}

function savePending(data: Record<string, PendingEntry>): void {
  mkdirSync(getStateDir(), { recursive: true })
  writeFileSync(pendingPath(), JSON.stringify(data, null, 2), 'utf-8')
  chmodSync(pendingPath(), 0o600)
}

export function loadAccessConfig(): AccessConfig {
  const path = configPath()
  if (!existsSync(path)) {
    return { policy: 'pairing', allowFrom: [] }
  }
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as AccessConfig
  } catch {
    return { policy: 'pairing', allowFrom: [] }
  }
}

export function saveAccessConfig(config: AccessConfig): void {
  mkdirSync(getStateDir(), { recursive: true })
  writeFileSync(configPath(), JSON.stringify(config, null, 2), 'utf-8')
  chmodSync(configPath(), 0o600)
}

/** Returns true if a free-form identifier (numeric id or @username) is allowed. */
export function isAllowed(identifier: string): boolean {
  const config = loadAccessConfig()
  if (config.policy === 'disabled') return true
  return config.allowFrom.includes(identifier)
}

export function addPendingPairing(userId: string): string {
  const pending = loadPending()
  const now = Date.now()
  for (const code of Object.keys(pending)) {
    if (pending[code]!.expiresAt < now) delete pending[code]
  }
  for (const [code, entry] of Object.entries(pending)) {
    if (entry.userId === userId) {
      savePending(pending)
      return code
    }
  }

  // Cryptographically random 6-digit code with collision check.
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = String(randomInt(100000, 1_000_000))
    if (!pending[code]) {
      pending[code] = { userId, expiresAt: now + 10 * 60 * 1000 }
      savePending(pending)
      return code
    }
  }
  throw new Error('Failed to generate unique pairing code')
}

export function confirmPairing(code: string): string | null {
  const pending = loadPending()
  const entry = pending[code]
  if (!entry || entry.expiresAt < Date.now()) {
    delete pending[code]
    savePending(pending)
    return null
  }
  delete pending[code]
  savePending(pending)

  const config = loadAccessConfig()
  if (!config.allowFrom.includes(entry.userId)) {
    config.allowFrom.push(entry.userId)
    saveAccessConfig(config)
  }
  return entry.userId
}
