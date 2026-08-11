import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { DEFAULT_API_BASE, loadAccount } from './accounts.js'
import {
  getActivePermissionChat,
  savePendingPermission,
} from './permissions.js'
import { sendText } from './send.js'
import {
  extractPermissionReply,
  sendTypingIndicator,
  startPollLoop,
} from './monitor.js'
import type {
  OnMessageCallback,
  OnPermissionResponseCallback,
  ParsedMessage,
  PermissionResponse,
} from './monitor.js'
import type { ChannelPermissionRequestParams } from './permissions.js'

export interface TelegramServerDeps {
  enableConfigs(): void
  initializeAnalyticsSink(): void
  shutdownDatadog(): Promise<void>
  shutdown1PEventLogging(): Promise<void>
  logForDebugging(message: string): void
  registerPermissionHandler(
    server: Server,
    handler: (request: ChannelPermissionRequestParams) => Promise<void>,
  ): void
}

function formatPermissionRequestMessage(
  request: ChannelPermissionRequestParams,
): string {
  return [
    'Claude Code needs your approval.',
    '',
    `Tool: ${request.tool_name}`,
    `Reason: ${request.description}`,
    `Input: ${request.input_preview}`,
    '',
    `Reply with: yes ${request.request_id}`,
    `Or deny with: no ${request.request_id}`,
  ].join('\n')
}

export function isChannelActive(): boolean {
  const raw = process.env.CLAUDE_ACTIVE_CHANNELS
  if (raw === undefined) return true
  return raw
    .split(',')
    .map(name => name.trim())
    .includes('telegram')
}

export function createTelegramMcpServer(version: string): Server {
  const server = new Server(
    { name: 'telegram', version },
    {
      capabilities: {
        experimental: {
          'claude/channel': {},
          'claude/channel/permission': {},
        },
        tools: {},
      },
      instructions:
        'Messages from Telegram arrive as <channel source="plugin:telegram:telegram" chat_id="..." sender_id="...">. Reply using the reply tool with the chat_id from the channel tag.',
    },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'reply',
        description:
          'Reply to a Telegram chat. Pass the chat_id from the channel tag.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            chat_id: {
              type: 'string',
              description: 'The chat_id from the channel notification',
            },
            text: { type: 'string', description: 'The reply text' },
            reply_to_message_id: {
              type: 'number',
              description: 'Optional original message_id to thread reply',
            },
          },
          required: ['chat_id', 'text'],
        },
      },
      {
        name: 'send_typing',
        description: 'Send a typing indicator to a Telegram chat.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            chat_id: {
              type: 'string',
              description: 'The chat_id from the channel tag',
            },
          },
          required: ['chat_id'],
        },
      },
    ],
  }))

  server.setRequestHandler(CallToolRequestSchema, async request => {
    const { name, arguments: args } = request.params
    const account = loadAccount()
    if (!account) {
      return {
        content: [
          {
            type: 'text',
            text: 'Telegram not connected. Run `ccb telegram login` first.',
          },
        ],
        isError: true,
      }
    }
    const baseUrl = account.baseUrl || DEFAULT_API_BASE
    const token = account.token

    switch (name) {
      case 'reply': {
        const chatId = typeof args?.chat_id === 'string' ? args.chat_id : ''
        const text = typeof args?.text === 'string' ? args.text : ''
        const replyTo =
          typeof args?.reply_to_message_id === 'number'
            ? args.reply_to_message_id
            : undefined

        if (!chatId || !text) {
          return {
            content: [
              { type: 'text', text: 'Missing chat_id or text parameter.' },
            ],
            isError: true,
          }
        }

        try {
          const resp = await sendText({
            to: chatId,
            text,
            baseUrl,
            token,
            replyToMessageId: replyTo,
          })
          return {
            content: [
              { type: 'text', text: `Message sent (id=${resp.messageId}).` },
            ],
          }
        } catch (error) {
          return {
            content: [
              {
                type: 'text',
                text: `Failed to send: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
            isError: true,
          }
        }
      }
      case 'send_typing': {
        const chatId = typeof args?.chat_id === 'string' ? args.chat_id : ''
        if (!chatId) {
          return {
            content: [{ type: 'text', text: 'Missing chat_id parameter.' }],
            isError: true,
          }
        }
        try {
          await sendTypingIndicator({ chatId, baseUrl, token })
          return {
            content: [{ type: 'text', text: 'Typing indicator sent.' }],
          }
        } catch (error) {
          return {
            content: [
              {
                type: 'text',
                text: `Failed to send typing: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
            isError: true,
          }
        }
      }
      default:
        return {
          content: [{ type: 'text', text: `Unknown tool: ${name}` }],
          isError: true,
        }
    }
  })

  return server
}

export async function runTelegramMcpServer(
  version: string,
  deps: TelegramServerDeps,
): Promise<void> {
  deps.enableConfigs()
  deps.initializeAnalyticsSink()

  const account = loadAccount()
  if (!account) {
    process.stderr.write(
      '[telegram] No account configured. Run `ccb telegram login` to connect your bot.\n',
    )
    await Promise.all([deps.shutdown1PEventLogging(), deps.shutdownDatadog()])
    process.exit(1)
  }

  const server = createTelegramMcpServer(version)
  const transport = new StdioServerTransport()

  deps.registerPermissionHandler(server, async request => {
    const targetChatId = request.channel_context?.chat_id
    const targetChat = targetChatId
      ? { chatId: targetChatId, contextToken: undefined }
      : getActivePermissionChat()

    if (!targetChat) {
      deps.logForDebugging(
        `[telegram] No active chat available for permission request ${request.request_id}`,
      )
      return
    }

    try {
      savePendingPermission(request, targetChat.chatId, targetChat.contextToken)
      await sendText({
        to: targetChat.chatId,
        text: formatPermissionRequestMessage(request),
        baseUrl: account.baseUrl || DEFAULT_API_BASE,
        token: account.token,
      })
    } catch (error) {
      process.stderr.write(
        `[telegram] Failed to relay permission request ${request.request_id}: ${error}\n`,
      )
    }
  })

  await server.connect(transport)

  const controller = new AbortController()

  let exiting = false
  const shutdownAndExit = async (): Promise<void> => {
    if (exiting) return
    exiting = true
    if (!controller.signal.aborted) controller.abort()
    await Promise.all([deps.shutdown1PEventLogging(), deps.shutdownDatadog()])
    process.exit(0)
  }

  process.stdin.on('end', () => void shutdownAndExit())
  process.stdin.on('error', () => void shutdownAndExit())
  process.on('SIGINT', () => void shutdownAndExit())
  process.on('SIGTERM', () => void shutdownAndExit())
  process.on('SIGHUP', () => void shutdownAndExit())

  const ppid = process.ppid
  const parentCheck = setInterval(() => {
    try {
      process.kill(ppid, 0)
    } catch {
      process.stderr.write(
        '[telegram] Parent process exited, shutting down...\n',
      )
      clearInterval(parentCheck)
      void shutdownAndExit()
    }
  }, 5000)

  const onMessage: OnMessageCallback = async (msg: ParsedMessage) => {
    await server.notification({
      method: 'notifications/claude/channel',
      params: {
        content: msg.text,
        meta: {
          chat_id: msg.chatId,
          sender_id: msg.fromUserId,
          message_id: String(msg.messageId),
        },
      },
    })
  }

  const onPermissionResponse: OnPermissionResponseCallback = async (
    response: PermissionResponse,
  ) => {
    await server.notification({
      method: 'notifications/claude/channel/permission',
      params: {
        request_id: response.requestId,
        behavior: response.behavior,
      },
    })
  }

  if (!isChannelActive()) {
    deps.logForDebugging(
      '[telegram] telegram not in --channels for this session; serving tools without polling',
    )
    await new Promise<void>(resolve => {
      controller.signal.addEventListener('abort', () => resolve(), {
        once: true,
      })
    })
    clearInterval(parentCheck)
    await shutdownAndExit()
    return
  }

  deps.logForDebugging('[telegram] Starting poll loop')
  try {
    await startPollLoop({
      baseUrl: account.baseUrl || DEFAULT_API_BASE,
      token: account.token,
      onMessage,
      onPermissionResponse,
      abortSignal: controller.signal,
    })
  } catch (error) {
    if (
      error instanceof Error &&
      (error.name === 'TelegramConflictError' ||
        error.name === 'TelegramAuthError')
    ) {
      process.stderr.write(`[telegram] Fatal poll error: ${error.message}\n`)
      clearInterval(parentCheck)
      await shutdownAndExit()
      return
    }
    throw error
  }

  clearInterval(parentCheck)
  await shutdownAndExit()
}
