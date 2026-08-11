import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { resolveDirectRoute, resolveDirectRoutes } from '../directRouter.js'

describe('CCB direct router', () => {
  it('resolves OpenCode directly to Zen', () => {
    const route = resolveDirectRoute('opencode/deepseek-v4-flash-free')
    expect(route?.baseURL).toBe('https://opencode.ai/zen/v1')
    expect(route?.apiKey).toBe('public')
    expect(route?.model).toBe('deepseek-v4-flash-free')
  })

  it('rejects old local gateway routes', () => {
    expect(resolveDirectRoute('embedded/auto/best-coding')).toBeUndefined()
  })

  it('puts OpenCode first in auto', () => {
    // Pin candidate pool to opencode only so live 9router DB scoring can't
    // re-order nvidia ahead of it on this machine.
    const previous = process.env.CCB_AUTO_CANDIDATES
    process.env.CCB_AUTO_CANDIDATES = 'opencode/deepseek-v4-flash-free'
    try {
      expect(resolveDirectRoutes('auto')[0]?.providerId).toBe('opencode')
    } finally {
      if (previous === undefined) delete process.env.CCB_AUTO_CANDIDATES
      else process.env.CCB_AUTO_CANDIDATES = previous
    }
  })

  it('does not fall back to unrelated configured providers', () => {
    const previous = {
      candidates: process.env.CCB_AUTO_CANDIDATES,
      assemblyai: process.env.CCB_ASSEMBLYAI_KEY,
    }
    process.env.CCB_AUTO_CANDIDATES = 'opencode/deepseek-v4-flash-free'
    process.env.CCB_ASSEMBLYAI_KEY = 'test-key'
    try {
      expect(
        resolveDirectRoutes('auto').map(route => route.providerId),
      ).toEqual(['opencode'])
    } finally {
      if (previous.candidates === undefined)
        delete process.env.CCB_AUTO_CANDIDATES
      else process.env.CCB_AUTO_CANDIDATES = previous.candidates
      if (previous.assemblyai === undefined)
        delete process.env.CCB_ASSEMBLYAI_KEY
      else process.env.CCB_ASSEMBLYAI_KEY = previous.assemblyai
    }
  })

  it('marks every L1 auto route for concurrent selection', () => {
    const previous = process.env.CCB_AUTO_CANDIDATES
    process.env.CCB_AUTO_CANDIDATES =
      'opencode/deepseek-v4-flash-free,nvidia/z-ai/glm-5.2'
    try {
      expect(resolveDirectRoutes('auto').every(route => route.race)).toBe(true)
    } finally {
      if (previous === undefined) delete process.env.CCB_AUTO_CANDIDATES
      else process.env.CCB_AUTO_CANDIDATES = previous
    }
  })

  it('races one shared-quota route and pairs each NVIDIA model with one key', () => {
    const previous = process.env.CCB_AUTO_CANDIDATES
    process.env.CCB_AUTO_CANDIDATES =
      'opencode/deepseek-v4-flash-free,nvidia/z-ai/glm-5.2,nvidia/minimaxai/minimax-m3'
    try {
      const routes = resolveDirectRoutes('auto')
      expect(
        routes.filter(route => route.providerId === 'opencode'),
      ).toHaveLength(1)
      const nvidia = routes.filter(route => route.providerId === 'nvidia')
      expect(nvidia).toHaveLength(2)
      expect(new Set(nvidia.map(route => route.accountId)).size).toBe(2)
      expect(new Set(nvidia.map(route => route.model)).size).toBe(2)
    } finally {
      if (previous === undefined) delete process.env.CCB_AUTO_CANDIDATES
      else process.env.CCB_AUTO_CANDIDATES = previous
    }
  })

  it('keeps remaining free OpenCode models as L1 downgrade routes', () => {
    const previous = process.env.CCB_AUTO_CANDIDATES
    process.env.CCB_AUTO_CANDIDATES =
      'opencode/first-free,opencode/second-free,opencode/third-free'
    try {
      const routes = resolveDirectRoutes('auto')
      expect(routes).toHaveLength(3)
      expect(routes.filter(route => route.race)).toHaveLength(2)
      expect(
        routes.filter(route => !route.race).map(route => route.model),
      ).toEqual(['third-free'])
    } finally {
      if (previous === undefined) delete process.env.CCB_AUTO_CANDIDATES
      else process.env.CCB_AUTO_CANDIDATES = previous
    }
  })

  it('keeps Headroom upstream paths relative to a versioned base URL', () => {
    const previous = {
      candidates: process.env.CCB_AUTO_CANDIDATES,
      headroom: process.env.CCB_HEADROOM_TOKEN_BASE_URL,
    }
    process.env.CCB_AUTO_CANDIDATES = 'opencode/deepseek-v4-flash-free'
    process.env.CCB_HEADROOM_TOKEN_BASE_URL = 'http://127.0.0.1:8787/v1'
    try {
      const route = resolveDirectRoutes('auto')[0]
      expect(route?.headers?.['x-headroom-base-url']).toBe(
        'https://opencode.ai/zen/v1',
      )
      expect(route?.headers?.['x-headroom-original-path']).toBe(
        '/chat/completions',
      )
    } finally {
      if (previous.candidates === undefined)
        delete process.env.CCB_AUTO_CANDIDATES
      else process.env.CCB_AUTO_CANDIDATES = previous.candidates
      if (previous.headroom === undefined)
        delete process.env.CCB_HEADROOM_TOKEN_BASE_URL
      else process.env.CCB_HEADROOM_TOKEN_BASE_URL = previous.headroom
    }
  })

  it('gives NVIDIA auto routes their 30-second timeout', () => {
    const previous = process.env.CCB_AUTO_CANDIDATES
    process.env.CCB_AUTO_CANDIDATES = 'nvidia/z-ai/glm-5.2'
    try {
      expect(resolveDirectRoutes('auto')[0]?.timeoutMs).toBe(30_000)
    } finally {
      if (previous === undefined) delete process.env.CCB_AUTO_CANDIDATES
      else process.env.CCB_AUTO_CANDIDATES = previous
    }
  })

  it('uses the L1/L2 auto pool for race', () => {
    const previous = process.env.CCB_AUTO_CANDIDATES
    process.env.CCB_AUTO_CANDIDATES = 'opencode/deepseek-v4-flash-free'
    try {
      expect(resolveDirectRoutes('race')[0]?.providerId).toBe('opencode')
    } finally {
      if (previous === undefined) delete process.env.CCB_AUTO_CANDIDATES
      else process.env.CCB_AUTO_CANDIDATES = previous
    }
  })

  it('does not repeat an L1 route in L2', () => {
    const previous = process.env.CCB_AUTO_CANDIDATES
    process.env.CCB_AUTO_CANDIDATES = 'opencode/deepseek-v4-flash-free'
    try {
      expect(resolveDirectRoutes('auto')).toHaveLength(1)
    } finally {
      if (previous === undefined) delete process.env.CCB_AUTO_CANDIDATES
      else process.env.CCB_AUTO_CANDIDATES = previous
    }
  })

  it('keeps CodeBuddy account downgrade in L1, not L2', () => {
    const previous = process.env.CCB_AUTO_CANDIDATES
    process.env.CCB_AUTO_CANDIDATES = 'codebuddy-cn/hy3-preview'
    try {
      const routes = resolveDirectRoutes('auto')
      expect(routes.length).toBeGreaterThan(1)
      expect(routes.every(route => route.tier === 'l1')).toBe(true)
      expect(routes.filter(route => route.race)).toHaveLength(1)
    } finally {
      if (previous === undefined) delete process.env.CCB_AUTO_CANDIDATES
      else process.env.CCB_AUTO_CANDIDATES = previous
    }
  })

  it('resolves namespaced CCB providers directly', () => {
    const previous = process.env.CCB_CODEBUDDY_CN_KEY
    process.env.CCB_CODEBUDDY_CN_KEY = 'test-key'
    const route = resolveDirectRoute('ccb/codebuddy-cn/kimi-k2.5')
    expect(route?.providerId).toBe('codebuddy-cn')
    expect(route?.model).toBe('kimi-k2.5')
    if (previous === undefined) delete process.env.CCB_CODEBUDDY_CN_KEY
    else process.env.CCB_CODEBUDDY_CN_KEY = previous
  })

  it('expands a fallback combo into ordered direct routes', () => {
    const previous = {
      openai: process.env.CCB_OPENAI_KEY,
      xai: process.env.CCB_XAI_KEY,
      kimi: process.env.CCB_KIMI_KEY,
      deepseek: process.env.CCB_DEEPSEEK_KEY,
    }
    process.env.CCB_OPENAI_KEY = 'test-openai'
    process.env.CCB_XAI_KEY = 'test-xai'
    process.env.CCB_KIMI_KEY = 'test-kimi'
    process.env.CCB_DEEPSEEK_KEY = 'test-deepseek'
    const routes = resolveDirectRoutes('ccb/advisor-combo')
    expect(routes.length).toBeGreaterThan(1)
    expect(routes[0]?.providerId).toBe('openai')
    for (const [key, value] of Object.entries(previous)) {
      const envKey = `CCB_${key.toUpperCase()}_KEY`
      if (value === undefined) delete process.env[envKey]
      else process.env[envKey] = value
    }
  })

  it('keeps advisor on the frontier fallback chain for every prompt', () => {
    const previous = {
      openai: process.env.CCB_OPENAI_KEY,
      xai: process.env.CCB_XAI_KEY,
    }
    process.env.CCB_OPENAI_KEY = 'test-openai'
    process.env.CCB_XAI_KEY = 'test-xai'
    try {
      // advisor starts with local Codex, then the OpenAI adapter appends the
      // auto routes. openai + xai must remain the frontier regardless of which
      // additional credentialed providers (e.g. kimi) get appended.
      const ids = resolveDirectRoutes('advisor', 'fix this').map(
        route => route.providerId,
      )
      expect(ids).toContain('openai')
      expect(ids).toContain('xai')
      expect(ids.slice(0, 2)).toEqual(['openai', 'xai'])
    } finally {
      if (previous.openai === undefined) delete process.env.CCB_OPENAI_KEY
      else process.env.CCB_OPENAI_KEY = previous.openai
      if (previous.xai === undefined) delete process.env.CCB_XAI_KEY
      else process.env.CCB_XAI_KEY = previous.xai
    }
  })

  it('puts local Codex before auto routes when ChatGPT OAuth is active', () => {
    const previous = process.env.OPENAI_AUTH_MODE
    const previousCandidates = process.env.CCB_AUTO_CANDIDATES
    process.env.OPENAI_AUTH_MODE = 'chatgpt'
    process.env.CCB_AUTO_CANDIDATES = 'opencode/deepseek-v4-flash-free'
    try {
      expect(
        resolveDirectRoutes('advisor').map(route => route.providerId),
      ).toEqual(['__ccb_local_codex_advisor__', 'opencode'])
    } finally {
      if (previous === undefined) delete process.env.OPENAI_AUTH_MODE
      else process.env.OPENAI_AUTH_MODE = previous
      if (previousCandidates === undefined)
        delete process.env.CCB_AUTO_CANDIDATES
      else process.env.CCB_AUTO_CANDIDATES = previousCandidates
    }
  })

  it('keeps every advisor alias on local Codex before auto when OAuth is active', () => {
    const previous = process.env.OPENAI_AUTH_MODE
    const previousCandidates = process.env.CCB_AUTO_CANDIDATES
    process.env.OPENAI_AUTH_MODE = 'chatgpt'
    process.env.CCB_AUTO_CANDIDATES = 'opencode/deepseek-v4-flash-free'
    try {
      for (const alias of [
        'lite',
        'full',
        'ultra',
        'review',
        'smart',
        'opus',
      ]) {
        expect(resolveDirectRoutes(alias)[0]?.providerId).toBe(
          '__ccb_local_codex_advisor__',
        )
      }
    } finally {
      if (previous === undefined) delete process.env.OPENAI_AUTH_MODE
      else process.env.OPENAI_AUTH_MODE = previous
      if (previousCandidates === undefined)
        delete process.env.CCB_AUTO_CANDIDATES
      else process.env.CCB_AUTO_CANDIDATES = previousCandidates
    }
  })
})
