// Unit tests for CompressionPipeline.
//
// These use pure steps only so they never spawn a
// process and stay fast + non-flaky. `manager.compress()` is exercised
// separately via a tiny fake to confirm step 3 wiring without any real spawn.

import { describe, it, expect } from 'bun:test'
import { CompressionPipeline } from '../pipeline.js'
import type { PipelineMessage } from '../pipeline.js'

describe('CompressionPipeline (no manager)', () => {
  const sample: PipelineMessage[] = [
    { role: 'user', content: 'hello there' },
    { role: 'assistant', content: 'hi, how can I help?' },
    { role: 'user', content: 'summarize the report please' },
  ]

  it('runs align + trim and returns new messages and stats without mutation', async () => {
    const input = sample.map(m => ({ ...m }))
    const inputRef = input // same array reference we pass in

    const pipe = new CompressionPipeline({ budgetTokens: 12 })
    const { messages, stats } = await pipe.run(input)

    // input array must not be mutated (different array, same original contents)
    expect(input).toBe(inputRef)
    expect(input).toEqual(sample)
    expect(messages).not.toBe(input)

    // stats recorded the steps that ran
    expect(stats.steps).toContain('cache-align')
    expect(stats.steps).toContain('trim-to-budget')
    expect(stats.steps).not.toContain('compress')
    expect(stats.inputTokens).toBeGreaterThan(0)
    expect(stats.outputTokens).toBeGreaterThan(0)
  })

  it('does not mutate individual input message objects', async () => {
    const input = sample.map(m => ({ ...m }))
    const originalContents = input.map(m => m.content)

    const pipe = new CompressionPipeline({ budgetTokens: 50 })
    await pipe.run(input)

    expect(input.map(m => m.content)).toEqual(originalContents)
  })

  it('honors useCacheAlign=false (skips align step)', async () => {
    const pipe = new CompressionPipeline({
      budgetTokens: 50,
      useCacheAlign: false,
    })
    const { stats } = await pipe.run(sample)
    expect(stats.steps).not.toContain('cache-align')
    expect(stats.steps).toContain('trim-to-budget')
  })

  it('skips trim when no budget is set', async () => {
    const pipe = new CompressionPipeline()
    const { messages, stats } = await pipe.run(sample)
    expect(stats.steps).toContain('cache-align')
    expect(stats.steps).not.toContain('trim-to-budget')
    // all messages preserved (align coalesces same-role runs only)
    expect(messages.length).toBeGreaterThan(0)
  })

  it('wires step 3 through a fake manager.compress() when useCompress is set', async () => {
    let called = false
    const fake = {
      compress: async (msgs: unknown) => {
        called = true
        return (msgs as PipelineMessage[]).map(m => ({
          role: m.role,
          content: m.content + ' [compressed]',
        }))
      },
    }

    const pipe = new CompressionPipeline({
      manager: fake,
      useCompress: true,
      useCacheAlign: false,
    })
    const { messages, stats } = await pipe.run(sample)

    expect(called).toBe(true)
    expect(stats.steps).toContain('compress')
    expect(messages.every(m => m.content.includes('[compressed]'))).toBe(true)
  })
})
