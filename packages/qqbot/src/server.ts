import { existsSync } from 'node:fs'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import {
  DEFAULT_API_BASE,
  loadAccount,
  getAppAccessTokenWithRetry,
} from './index.js'
import {
  startPollLoop,
  getActivePermissionChat,
  savePendingPermission,
} from './index.js'
import { sendText } from './send.js'
import type { ParsedMessage, PermissionResponse } from './monitor.js'
import type { ChannelPermissionRequestParams } from './permissions.js'

export interface QqbotServerDeps {
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

export function createQqbotMcpServer(version: string): Server {
  const server = new Server(
    { name: 'qqbot', version },
    {
      capabilities: {
        experimental: {
          'claude/channel': {},
          'claude/channel/permission': {},
        },
        tools: {},
      },
      instructions:
        'Messages from QQ arrive as <channel source="plugin:qqbot:qqbot" chat_id="..." sender_id="...">. Reply using the reply tool with the chat_id from the channel tag. Use absolute paths for file attachments.',
    },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'reply',
        description:
          'Reply to a QQ message. Pass the chat_id from the channel tag.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            chat_id: {
              type: 'string',
              description: 'The chat_id from the channel notification',
            },
            text: { type: 'string', description: 'The reply text' },
            files: {
              type: 'array',
              items: { type: 'string' },
              description: 'Optional absolute file paths to attach',
            },
          },
          required: ['chat_id', 'text'],
        },
      },
      {
        name: 'send_typing',
        description: 'Send a typing indicator to a QQ user.',
        inputSchema: {
          type: 'object' as const,
          properties: {
            chat_id: { type: 'string', description: 'The chat_id (user ID)' },
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
            text: 'QQ not connected. Run `ccb qqbot login` first.',
          },
        ],
        isError: true,
      }
    }

    const baseUrl = DEFAULT_API_BASE

    switch (name) {
      case 'reply': {
        const chatId = typeof args?.chat_id === 'string' ? args.chat_id : ''
        const text = typeof args?.text === 'string' ? args.text : ''
        const files = Array.isArray(args?.files)
          ? args.files.filter(
              (value): value is string => typeof value === 'string',
            )
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
          // Files not yet supported for QQ C2C; only text.
          if (files && files.length > 0) {
            for (const filePath of files) {
              if (!existsSync(filePath)) {
                return {
                  content: [
                    { type: 'text', text: `File not found: ${filePath}` },
                  ],
                  isError: true,
                }
              }
            }
          }

          const token = await getAppAccessTokenWithRetry(account)
          await sendText({
            to: chatId,
            text,
            baseUrl,
            token,
          })
          return { content: [{ type: 'text', text: 'Message sent.' }] }
        } catch (error) {
          return {
            content: [{ type: 'text', text: `Failed to send: ${error}` }],
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
        return {
          content: [{ type: 'text', text: 'Typing indicator sent.' }],
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

export function isChannelActive(): boolean {
  const raw = process.env.CLAUDE_ACTIVE_CHANNELS
  if (raw === undefined) return true
  return raw
    .split(',')
    .map(name => name.trim())
    .includes('qqbot')
}

export async function runQqbotMcpServer(
  version: string,
  deps: QqbotServerDeps,
): Promise<void> {
  deps.enableConfigs()
  deps.initializeAnalyticsSink()

  const account = loadAccount()
  if (!account) {
    process.stderr.write(
      '[qqbot] No account configured. Run `ccb qqbot login` to connect your QQ account.\n',
    )
    await Promise.all([deps.shutdown1PEventLogging(), deps.shutdownDatadog()])
    process.exit(1)
  }

  const server = createQqbotMcpServer(version)
  const transport = new StdioServerTransport()

  deps.registerPermissionHandler(server, async request => {
    const targetChatId = request.channel_context?.chat_id
    const targetChat = targetChatId
      ? { chatId: targetChatId, contextToken: undefined }
      : getActivePermissionChat()

    if (!targetChat) {
      deps.logForDebugging(
        `[Qqbot MCP] No active chat available for permission request ${request.request_id}`,
      )
      return
    }

    try {
      savePendingPermission(request, targetChat.chatId, targetChat.contextToken)
      const token = await getAppAccessTokenWithRetry(account)
      await sendText({
        to: targetChat.chatId,
        text: formatPermissionRequestMessage(request),
        baseUrl: DEFAULT_API_BASE,
        token,
      })
    } catch (error) {
      process.stderr.write(
        `[qqbot] Failed to relay permission request ${request.request_id}: ${error}\n`,
      )
    }
  })

  await server.connect(transport)

  const controller = new AbortController()

  let exiting = false
  const shutdownAndExit = async (): Promise<void> => {
    if (exiting) return
    exiting = true
    if (!controller.signal.aborted) {
      controller.abort()
    }
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
      process.stderr.write('[qqbot] Parent process exited, shutting down...\n')
      clearInterval(parentCheck)
      void shutdownAndExit()
    }
  }, 5000)

  if (!isChannelActive()) {
    deps.logForDebugging(
      '[Qqbot MCP] qqbot not in --channels for this session; serving tools without polling',
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

  deps.logForDebugging('[Qqbot MCP] Starting poll loop')
  const token = await getAppAccessTokenWithRetry(account)
  await startPollLoop({
    baseUrl: DEFAULT_API_BASE,
    token,
    onMessage: async (msg: ParsedMessage) => {
      await server.notification({
        method: 'notifications/claude/channel',
        params: {
          content: msg.text,
          meta: {
            chat_id: msg.fromUserId,
            sender_id: msg.fromUserId,
            message_id: msg.messageId,
          },
        },
      })
    },
    onPermissionResponse: async (response: PermissionResponse) => {
      await server.notification({
        method: 'notifications/claude/channel/permission',
        params: {
          request_id: response.requestId,
          behavior: response.behavior,
        },
      })
    },
    abortSignal: controller.signal,
  })

  clearInterval(parentCheck)
  await shutdownAndExit()
}
