import { saveAccount, type AccountData } from './accounts.js'
import { getAppAccessTokenWithRetry, CHANNEL_VERSION } from './api.js'

export interface LoginResult {
  connected: boolean
  token?: string
  message: string
}

export async function startLogin(account: AccountData): Promise<LoginResult> {
  try {
    const token = await getAppAccessTokenWithRetry(account)
    saveAccount({
      ...account,
      appAccessToken: token,
      savedAt: new Date().toISOString(),
    })
    return {
      connected: true,
      token,
      message: 'Connected to QQ bot successfully!',
    }
  } catch (error) {
    return {
      connected: false,
      message: `Login failed: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

export const QQ_CHANNEL_VERSION = CHANNEL_VERSION
