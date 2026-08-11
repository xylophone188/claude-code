// Unit tests for the embedded context MCP adapter.
//
// No process or network is touched.

import { describe, it, expect } from 'bun:test'
import { contextMcpTools, dispatch, registerContextMcp } from '../mcp.js'

describe('context MCP adapter', () => {
  it('exposes the three context tools with a valid shape', () => {
    const names = contextMcpTools.map(t => t.name)
    expect(names).toEqual([
      'context_start',
      'context_compress',
      'context_cache_align',
    ])

    for (const t of contextMcpTools) {
      expect(typeof t.name).toBe('string')
      expect(typeof t.description).toBe('string')
      expect(t.inputSchema).toBeInstanceOf(Object)
      expect((t.inputSchema as any).type).toBe('object')
    }
  })

  it('dispatch context_cache_align returns a deterministic aligned array', async () => {
    const blocks = [{ a: 1 }, {}, null, { b: 2 }]
    const result = (await dispatch('context_cache_align', {
      blocks,
    })) as unknown[]
    // Inline fallback drops null and empty objects, keeps order stable.
    expect(result).toEqual([{ a: 1 }, { b: 2 }])
  })

  it('dispatch context_compress echoes messages when no manager is given', async () => {
    const messages = [{ role: 'user', content: 'hi' }]
    const result = (await dispatch('context_compress', {
      messages,
    })) as unknown[]
    expect(result).toEqual(messages)
  })

  it('dispatch context_start reports embedded availability', async () => {
    const result = await dispatch('context_start', {})
    expect(result).toEqual({ embedded: true })
  })

  it('registerContextMcp calls addTool once per tool', () => {
    const registered: any[] = []
    const server = { addTool: (t: any) => registered.push(t) }
    registerContextMcp(server)
    expect(registered.length).toBe(3)
    expect(registered.map(t => t.name)).toEqual([
      'context_start',
      'context_compress',
      'context_cache_align',
    ])
  })
})
