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

export const DEFAULT_APP_ACCESS_TOKEN_URL =
  'https://bots.qq.com/app/getAppAccessToken'
export const DEFAULT_API_BASE = 'https://api.sgroup.qq.com'

export interface AccountData {
  /** QQ bot app id */
  appId: string
  /** QQ bot client secret */
  clientSecret: string
  /** optional pre-issued app access token (rarely provided directly) */
  appAccessToken?: string
  userId?: string
  savedAt: string
}

export function getStateDir(): string {
  const dir =
    process.env.QQBOT_STATE_DIR ||
    join(homedir(), '.claude', 'channels', 'qqbot')
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
  if (existsSync(path)) {
    unlinkSync(path)
  }
}
