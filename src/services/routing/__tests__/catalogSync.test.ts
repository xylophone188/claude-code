import { describe, expect, it } from 'bun:test'
import {
  catalogIsFresh,
  extractTextModels,
  mergeCatalogWithStatic,
  syncProviderModelCatalog,
} from '../catalogSync.js'

describe('extractTextModels', () => {
  it('parses the OpenAI { data: [{ id }] } shape', () => {
    expect(
      extractTextModels({
        data: [{ id: 'sensenova-6.8-flash-lite' }, { id: 'glm-5.2' }],
      }),
    ).toEqual(['sensenova-6.8-flash-lite', 'glm-5.2'])
  })

  it('parses the { data: [string] } shape', () => {
    expect(
      extractTextModels({ data: ['deepseek-v4-flash', 'glm-5.2'] }),
    ).toEqual(['deepseek-v4-flash', 'glm-5.2'])
  })

  it('drops ids and modalities that are not text generation', () => {
    expect(
      extractTextModels({
        data: [
          { id: 'glm-5.2' },
          { id: 'bge-m3-embedding', modalities: ['embedding'] },
          { id: 'qwen-vl-max' },
          { id: 'mini-max-tts' },
        ],
      }),
    ).toEqual(['glm-5.2'])
  })

  it('ignores non-object payloads and dedupes results', () => {
    expect(extractTextModels(null)).toEqual([])
    expect(extractTextModels({ data: ['a', 'a', 'b'] })).toEqual(['a', 'b'])
    expect(extractTextModels({ data: 'not-an-array' })).toEqual([])
  })
})

describe('catalogIsFresh', () => {
  const now = 1_000_000_000_000
  const fresh = {
    providerId: 'sensenova',
    updatedAt: new Date(now).toISOString(),
    models: ['glm-5.2'],
  }

  it('accepts a recent, non-empty catalog', () => {
    expect(catalogIsFresh(fresh, now + 60_000)).toBe(true)
  })

  it('rejects missing, empty, and future-dated catalogs', () => {
    expect(catalogIsFresh(undefined, now)).toBe(false)
    expect(catalogIsFresh({ ...fresh, models: [] }, now)).toBe(false)
    expect(catalogIsFresh({ ...fresh, updatedAt: 'not-a-date' }, now)).toBe(
      false,
    )
  })

  it('expires past the TTL', () => {
    expect(catalogIsFresh(fresh, now + 8 * 60 * 60 * 1000)).toBe(false)
    expect(catalogIsFresh(fresh, now + 8 * 60 * 60 * 1000 - 1)).toBe(true)
  })
})

describe('syncProviderModelCatalog', () => {
  const now = 1_000_000_000_000

  it('skips the network when the current catalog is fresh', async () => {
    let called = false
    const current = {
      providerId: 'sensenova',
      updatedAt: new Date(now).toISOString(),
      models: ['glm-5.2'],
    }
    const result = await syncProviderModelCatalog({
      providerId: 'sensenova',
      endpoint: 'https://sensenova.cn/v1/models',
      current,
      now: now + 1_000,
      fetcher: (async () => {
        called = true
        throw new Error('must not be called')
      }) as unknown as typeof fetch,
    })
    expect(result).toBe(current)
    expect(called).toBe(false)
  })

  it('refreshes from the endpoint when stale', async () => {
    const stale = {
      providerId: 'sensenova',
      updatedAt: new Date(now - 9 * 60 * 60 * 1000).toISOString(),
      models: ['glm-5.2'],
    }
    const result = await syncProviderModelCatalog({
      providerId: 'sensenova',
      endpoint: 'https://sensenova.cn/v1/models',
      current: stale,
      now,
      fetcher: (async () =>
        new Response(
          JSON.stringify({
            data: [{ id: 'glm-5.2' }, { id: 'deepseek-v4-flash' }],
          }),
          { status: 200 },
        )) as unknown as typeof fetch,
    })
    expect(result?.models).toEqual(['glm-5.2', 'deepseek-v4-flash'])
    expect(result?.updatedAt).toBe(new Date(now).toISOString())
  })

  it('keeps the current catalog on fetch failure and empty responses', async () => {
    const current = {
      providerId: 'sensenova',
      updatedAt: new Date(now - 9 * 60 * 60 * 1000).toISOString(),
      models: ['glm-5.2'],
    }
    const onError = await syncProviderModelCatalog({
      providerId: 'sensenova',
      endpoint: 'https://sensenova.cn/v1/models',
      current,
      now,
      fetcher: (async () => {
        throw new Error('network down')
      }) as unknown as typeof fetch,
    })
    expect(onError).toBe(current)

    const onEmpty = await syncProviderModelCatalog({
      providerId: 'sensenova',
      endpoint: 'https://sensenova.cn/v1/models',
      current,
      now,
      fetcher: (async () =>
        new Response(JSON.stringify({ data: [] }), {
          status: 200,
        })) as unknown as typeof fetch,
    })
    expect(onEmpty).toBe(current)

    const onNonOk = await syncProviderModelCatalog({
      providerId: 'sensenova',
      endpoint: 'https://sensenova.cn/v1/models',
      current,
      now,
      fetcher: (async () =>
        new Response('server error', {
          status: 503,
        })) as unknown as typeof fetch,
    })
    expect(onNonOk).toBe(current)
  })
})

describe('mergeCatalogWithStatic', () => {
  it('prefers live catalog ids and appends static-only ids', () => {
    const merged = mergeCatalogWithStatic(
      {
        providerId: 'sensenova',
        updatedAt: 'x',
        models: ['glm-5.2', 'deepseek-v4-flash'],
      },
      ['deepseek-v4-flash', 'sensenova-6.8-flash-lite'],
    )
    expect(merged).toEqual([
      'glm-5.2',
      'deepseek-v4-flash',
      'sensenova-6.8-flash-lite',
    ])
  })

  it('keeps static ids when the catalog is missing', () => {
    expect(mergeCatalogWithStatic(undefined, ['glm-5.2'])).toEqual(['glm-5.2'])
  })
})
