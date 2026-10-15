export interface SearchEngineOptions {
  host?: string
  timeoutMs?: number
}

export interface SearchQuery {
  text: string
  fields: string[]
  limit?: number
}

export interface SearchHit {
  id: string
  score: number
  source: Record<string, unknown>
}

export interface SearchResults {
  hits: SearchHit[]
}

const DEFAULT_TIMEOUT_MS = 5_000

export class SearchEngineClient {
  private readonly host: string
  private readonly timeoutMs: number

  constructor(options: SearchEngineOptions = {}) {
    this.host = (options.host ?? 'http://127.0.0.1:9200').replace(/\/+$/, '')
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await fetch(`${this.host}/${path.replace(/^\/+/, '')}`, {
        ...init,
        signal: controller.signal,
        headers: {
          'content-type': 'application/json',
          ...init?.headers,
        },
      })
      const body = await response.text()
      if (!response.ok) {
        throw new Error(`Search engine ${response.status}: ${body}`)
      }
      if (!body) return undefined as T
      return JSON.parse(body) as T
    } finally {
      clearTimeout(timer)
    }
  }

  async ping(): Promise<boolean> {
    try {
      const info = await this.request<any>('')
      return info?.tagline === 'You know, for search'
    } catch {
      return false
    }
  }

  async createIndex(index: string): Promise<void> {
    const body = {
      settings: {
        number_of_shards: 1,
        number_of_replicas: 0,
      },
      mappings: {
        properties: {
          node_id: { type: 'keyword' },
          text: { type: 'text' },
        },
      },
    }
    try {
      await this.request(`/${index}`)
    } catch {
      await this.request(`/${index}`, {
        method: 'PUT',
        body: JSON.stringify(body),
      })
    }
  }

  async createIndexWithIK(index: string): Promise<void> {
    const body = {
      settings: {
        number_of_shards: 1,
        number_of_replicas: 0,
        analysis: {
          analyzer: {
            ik_max_pinyin: {
              type: 'custom',
              tokenizer: 'ik_max_word',
              filter: ['ik_max_word_pinyin'],
            },
          },
        },
      },
      mappings: {
        properties: {
          node_id: { type: 'keyword' },
          text: {
            type: 'text',
            analyzer: 'ik_max_pinyin',
            search_analyzer: 'ik_smart',
          },
        },
      },
    }
    try {
      await this.request(`/${index}`)
    } catch {
      await this.request(`/${index}`, {
        method: 'PUT',
        body: JSON.stringify(body),
      })
    }
  }

  async indexDocument(
    index: string,
    docId: string,
    document: Record<string, unknown>,
  ): Promise<{ ok: boolean }> {
    await this.request(`/${index}/_doc/${docId}`, {
      method: 'PUT',
      body: JSON.stringify(document),
    })
    return { ok: true }
  }

  async search(index: string, query: SearchQuery): Promise<SearchResults> {
    const request = {
      size: query.limit ?? 10,
      query: {
        multi_match: {
          query: query.text,
          fields: query.fields,
        },
      },
    }
    const result = await this.request<any>(`/${index}/_search`, {
      method: 'POST',
      body: JSON.stringify(request),
    })
    const hits = (result?.hits?.hits ?? []).map((hit: any) => ({
      id: hit._id,
      score: hit._score,
      source: hit._source ?? {},
    }))
    return { hits }
  }

  async deleteDocument(index: string, docId: string): Promise<void> {
    await this.request(`/${index}/_doc/${docId}`, { method: 'DELETE' })
  }

  async indexExists(index: string): Promise<boolean> {
    try {
      await this.request(`/${index}`)
      return true
    } catch {
      return false
    }
  }
}

let client: SearchEngineClient | null = null

export function getSearchEngine(
  options: SearchEngineOptions = {},
): SearchEngineClient {
  if (!client) client = new SearchEngineClient(options)
  return client
}

export async function searchEnginePing(): Promise<boolean> {
  try {
    return await getSearchEngine().ping()
  } catch {
    return false
  }
}
