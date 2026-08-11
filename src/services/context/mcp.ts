// MCP adapter exposing CCB's in-process context tools.
//
// This module turns the context subsystem into a set of
// MCP-compatible tool descriptors so it can be registered onto an MCP server
// (e.g. an injected server stub in tests, or a real MCP server in ccb).
//
// The tools are intentionally process-free where possible so they can be
// exercised in unit tests without any external process:
//   - context_start      : report embedded availability
//   - context_compress   : compress messages (pure pass-through if no manager)
//   - context_cache_align: pure cache-block alignment

import { alignCacheBlocks, type ChatMessage } from './cacheAlign.js'

/**
 * Pure cache-block alignment fallback.
 *
 * Re-aligns a list of message blocks so provider prompt-cache breakpoints line
 * up predictably.
 */
async function cacheAlignFallback(blocks: unknown): Promise<unknown> {
  if (!Array.isArray(blocks)) return []
  // Deterministic, side-effect-free alignment: drop null/empty blocks and keep
  // order stable. Good enough for a stub and fully deterministic for tests.
  return blocks.filter(
    b =>
      b != null &&
      !(typeof b === 'object' && Object.keys(b as object).length === 0),
  )
}

/**
 * Resolve cache alignment for arbitrary blocks.
 */
async function resolveCacheAlign(blocks: unknown): Promise<unknown> {
  if (!Array.isArray(blocks)) return []
  if (
    blocks.every(
      block =>
        block &&
        typeof block === 'object' &&
        'role' in block &&
        'content' in block,
    )
  ) {
    return alignCacheBlocks(blocks as ChatMessage[])
  }
  return cacheAlignFallback(blocks)
}

/** MCP tool descriptor shape. */
export interface McpToolDescriptor {
  name: string
  description: string
  inputSchema: object
}

export const contextMcpTools: Array<McpToolDescriptor> = [
  {
    name: 'context_start',
    description: 'Report that CCB context processing is embedded.',
    inputSchema: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'context_compress',
    description:
      'Best-effort in-process compression of a message list. ' +
      'Returns the (possibly compressed) message array.',
    inputSchema: {
      type: 'object',
      properties: {
        messages: {
          type: 'array',
          description: 'Conversation messages to compress',
        },
      },
      required: ['messages'],
      additionalProperties: false,
    },
  },
  {
    name: 'context_cache_align',
    description:
      'Re-align message blocks so provider prompt-cache breakpoints line up ' +
      'predictably. Pure function, no process spawned.',
    inputSchema: {
      type: 'object',
      properties: {
        blocks: {
          type: 'array',
          description: 'Cache blocks to align',
        },
      },
      required: ['blocks'],
      additionalProperties: false,
    },
  },
]

/**
 * Dispatch an MCP tool call to its embedded implementation.
 *
 * @param toolName  one of context_start | context_compress | context_cache_align
 * @param args      parsed JSON arguments object
 * @param manager   optional in-process compressor
 * @returns         the tool result (awaitable)
 */
export async function dispatch(
  toolName: string,
  args: any,
  manager?: { compress: (messages: unknown) => Promise<unknown> },
): Promise<unknown> {
  switch (toolName) {
    case 'context_start': {
      return { embedded: true }
    }

    case 'context_compress': {
      const messages = args?.messages ?? []
      if (manager) {
        return await manager.compress(messages)
      }
      // No-op-safe: echo the messages back as a resolved value.
      return messages
    }

    case 'context_cache_align': {
      const blocks = args?.blocks ?? []
      return await resolveCacheAlign(blocks)
    }

    default:
      throw new Error(`unknown context tool: ${toolName}`)
  }
}

/**
 * Register the context MCP tools onto an injected server stub (anything with
 * an `addTool` method). Keeps dispatch testable without a real MCP server.
 */
export function registerContextMcp(server: {
  addTool: (t: any) => void
}): void {
  for (const tool of contextMcpTools) {
    server.addTool({
      ...tool,
      handler: (args: any) => dispatch(tool.name, args),
    })
  }
}

export default { contextMcpTools, dispatch, registerContextMcp }
