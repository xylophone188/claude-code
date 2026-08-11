import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const DEFAULT_API_BASE = 'https://api.telegram.org'
export const MAX_MESSAGE_LENGTH = 4096

export interface AccountData {
  token: string
  savedAt: string
  botUsername?: string
  botId?: string
  baseUrl?: string
}

export function getStateDir(): string {
  const dir =
    process.env.TELEGRAM_STATE_DIR ||
    join(homedir(), '.claude', 'channels', 'telegram')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return dir
}

function accountPath(): string {
  return join(getStateDir(), 'account.json')
}

export function loadAccount(): AccountData | null {
  const path = accountPath()
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as AccountData
  } catch {
    return null
  }
}

export function saveAccount(data: AccountData): void {
  const path = accountPath()
  writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8')
  chmodSync(path, 0o600)
}

export function clearAccount(): void {
  const path = accountPath()
  if (existsSync(path)) unlinkSync(path)
}
