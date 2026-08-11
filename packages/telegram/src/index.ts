// @claude-code-best/telegram — Telegram Bot API channel integration

export { DEFAULT_API_BASE, MAX_MESSAGE_LENGTH } from './accounts.js'
export type { AccountData } from './accounts.js'
export {
  loadAccount,
  saveAccount,
  clearAccount,
  getStateDir,
} from './accounts.js'

export {
  TelegramApiError,
  TelegramAuthError,
  TelegramConflictError,
} from './types.js'
export type {
  TelegramUser,
  TelegramChat,
  TelegramMessage,
  TelegramUpdate,
  TelegramApiResponse,
  SendMessageReq,
  SendChatActionReq,
  GetUpdatesReq,
} from './types.js'

export {
  getMe,
  getUpdates,
  sendMessage,
  sendChatAction,
  retryAfterSeconds,
} from './api.js'

export { markdownToPlainText, sendText } from './send.js'

export {
  loadAccessConfig,
  saveAccessConfig,
  isAllowed,
  addPendingPairing,
  confirmPairing,
} from './pairing.js'
export type { AccessConfig } from './pairing.js'

export {
  setActivePermissionChat,
  getActivePermissionChat,
  savePendingPermission,
  consumePendingPermission,
  clearPermissionStateForTests,
} from './permissions.js'
export type {
  ChannelPermissionRequestParams,
  PendingPermissionRequest,
  ActivePermissionChat,
} from './permissions.js'

export {
  extractPermissionReply,
  startPollLoop,
  sendTypingIndicator,
} from './monitor.js'
export type {
  ParsedMessage,
  OnMessageCallback,
  PermissionResponse,
  OnPermissionResponseCallback,
  StartPollLoopParams,
} from './monitor.js'

export { loginFromStdin, loginWithToken } from './login.js'
export type { LoginResult } from './login.js'

export {
  createTelegramMcpServer,
  runTelegramMcpServer,
  isChannelActive,
} from './server.js'
export type { TelegramServerDeps } from './server.js'

export { handleTelegramCli } from './cli.js'
