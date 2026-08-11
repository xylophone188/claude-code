import { describe, expect, it } from 'bun:test'
import { CompressionPipeline } from '../pipeline.js'

describe('embedded context processing', () => {
  it('runs without child processes or external services', async () => {
    const result = await new CompressionPipeline({ budgetTokens: 10 }).run([
      { role: 'user', content: 'a'.repeat(80) },
      { role: 'assistant', content: 'done' },
    ])
    expect(result.messages.at(-1)?.content).toBe('done')
    expect(result.stats.steps).toContain('trim-to-budget')
  })
})
