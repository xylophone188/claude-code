import { describe, expect, it } from 'bun:test'
import { resolveWorkflowMode } from './mode.js'

describe('Kilo workflow aliases', () => {
  it('maps common workflows to existing CCB modes', () => {
    expect(resolveWorkflowMode('code')).toBe('default')
    expect(resolveWorkflowMode('implement')).toBe('workhorse')
    expect(resolveWorkflowMode('debug')).toBe('sharp')
    expect(resolveWorkflowMode('review')).toBe('sharp')
    expect(resolveWorkflowMode('fast')).toBe('token-saver')
  })

  it('keeps custom CCB modes unchanged', () => {
    expect(resolveWorkflowMode('super-ai')).toBe('super-ai')
  })
})
