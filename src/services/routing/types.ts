export interface CCBRoutingProvider {
  id: string // e.g. "openai/gpt-4o" or "anthropic/claude-3-5-sonnet"
  kind: 'openai-compat'
  baseUrl: string // base URL WITHOUT trailing /chat/completions
  apiKeyEnv?: string // env var name, e.g. "OPENAI_API_KEY" or "CCB_OPENAI_KEY"
  defaultModel?: string
  compatRule?: 'permissive' | 'strict'
  models?: string[]
  headers?: Record<string, string>
  noAuth?: boolean
}

export interface CCBRoutingCombo {
  name: string
  strategy: 'fallback' | 'fusion' | 'sticky-round-robin'
  models: string[] // provider/model ids
  stickyLimit?: number
}

export interface CCBRoutingAlias {
  alias: string // user-facing short name
  target: string // provider/model id OR combo name
}
