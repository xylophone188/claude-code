// @claude-code-best/telegram — Telegram Bot API types

export interface TelegramUser {
  id: number
  is_bot?: boolean
  username?: string
  first_name?: string
  last_name?: string
}

export interface TelegramChat {
  id: number
  type: 'private' | 'group' | 'supergroup' | 'channel'
  title?: string
  username?: string
}

export interface TelegramMessage {
  message_id: number
  date: number
  chat: TelegramChat
  from?: TelegramUser
  text?: string
  caption?: string
}

export interface TelegramUpdate {
  update_id: number
  message?: TelegramMessage
  edited_message?: TelegramMessage
  channel_post?: TelegramMessage
  my_chat_member?: unknown
}

export interface TelegramApiResponse<T> {
  ok: boolean
  result?: T
  description?: string
  error_code?: number
  parameters?: { retry_after?: number; migrate_to_chat_id?: number }
}

export interface SendMessageReq {
  chat_id: number | string
  text: string
  parse_mode?: 'MarkdownV2' | 'HTML' | 'Markdown'
  reply_to_message_id?: number
}

export interface SendChatActionReq {
  chat_id: number | string
  action:
    | 'typing'
    | 'upload_photo'
    | 'record_video'
    | 'upload_video'
    | 'record_voice'
    | 'upload_voice'
    | 'upload_document'
    | 'find_location'
    | 'record_video_note'
    | 'upload_video_note'
}

export interface GetUpdatesReq {
  offset?: number
  limit?: number
  timeout?: number
  allowed_updates?: string[]
}

export class TelegramApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly description: string,
    public readonly parameters?: { retry_after?: number },
  ) {
    super(`Telegram API error ${statusCode}: ${description}`)
    this.name = 'TelegramApiError'
  }
}

export class TelegramAuthError extends Error {
  constructor(description: string) {
    super(`Telegram auth failed: ${description}`)
    this.name = 'TelegramAuthError'
  }
}

export class TelegramConflictError extends Error {
  constructor(description: string) {
    super(`Telegram conflict: ${description}`)
    this.name = 'TelegramConflictError'
  }
}
