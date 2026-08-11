// @claude-code-best/qqbot — QQ (QQ Bot / 频道机器人) channel types

export const MessageType = {
  /** plaintext */
  PLAIN: 0,
  /** markdown */
  MARKDOWN: 2,
  /** keyboard / inline markup */
  KEYBOARD: 3,
  /** typing indicator */
  TYPING: 6,
} as const

export const TypingInputType = {
  /** typing */
  INPUTTING: 1,
} as const

export interface GetAppAccessTokenResp {
  access_token?: string
  expires_in?: number
  token_type?: string
}

export interface C2CSendBody {
  msg_type: number
  content?: string
  markdown?: { content: string }
  keyboard?: unknown
  msg_seq?: number
  msg_id?: string
  event_id?: string
}

export interface C2CSendResp {
  id?: string
  openid?: string
  code?: number
  message?: string
}

export type GatewayOpcode =
  | 0 // DISPATCH
  | 1 // HEARTBEAT
  | 2 // IDENTIFY
  | 6 // RESUME
  | 7 // RECONNECT
  | 9 // INVALID_SESSION
  | 10 // HELLO
  | 11 // HEARTBEAT_ACK
  | 12 // HTTP_CALLBACK

export interface GatewayMessage {
  op: GatewayOpcode
  d?: unknown
  s?: number
  t?: string
}

export interface GatewayHelloData {
  heartbeat_interval?: number
}

export interface GatewayDispatchData {
  content?: string
  author?: { id?: string; user_openid?: string }
  direct_message?: boolean
  msg_id?: string
  id?: string
  event_id?: string
  group_openid?: string
  guild_id?: string
  channel_id?: string
}

export interface OutgoingMessage {
  chatId: string
  text: string
  isGroup: boolean
}
