import { getMe } from './api.js'
import { DEFAULT_API_BASE, saveAccount, type AccountData } from './accounts.js'

export interface LoginResult {
  connected: boolean
  botUsername?: string
  botId?: number
  message: string
}

/**
 * Validate a bot token by calling getMe and persist the result. The token is
 * accepted via stdin (one-shot read) so it does not appear in argv, shell
 * history, or process listings.
 */
export async function loginFromStdin(
  apiBaseUrl?: string,
): Promise<LoginResult> {
  const token = (await readTokenFromStdin()).trim()
  if (!token) {
    return { connected: false, message: 'No token provided on stdin' }
  }

  return loginWithToken(token, apiBaseUrl)
}

export async function loginWithToken(
  token: string,
  apiBaseUrl?: string,
): Promise<LoginResult> {
  const baseUrl = apiBaseUrl || DEFAULT_API_BASE
  let me
  try {
    me = await getMe(baseUrl, token)
  } catch (error) {
    return {
      connected: false,
      message: `Token validation failed: ${error instanceof Error ? error.message : String(error)}`,
    }
  }

  const account: AccountData = {
    token,
    savedAt: new Date().toISOString(),
    botUsername: me.username,
    botId: String(me.id),
  }
  saveAccount(account)

  return {
    connected: true,
    botUsername: me.username,
    botId: me.id,
    message: me.username
      ? `Connected to @${me.username}`
      : `Connected to bot ${me.id}`,
  }
}

async function readTokenFromStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    // Interactive fallback — best-effort prompt without leaking to argv.
    process.stderr.write('Paste bot token (hidden): ')
  }
  return new Promise<string>(resolve => {
    let buffer = ''
    const onData = (chunk: Buffer | string): void => {
      buffer += chunk.toString('utf-8')
    }
    const onEnd = (): void => {
      process.stdin.off('data', onData)
      resolve(buffer)
    }
    process.stdin.on('data', onData)
    process.stdin.once('end', onEnd)
    process.stdin.once('close', onEnd)
  })
}
