import { z } from 'zod'

/**
 * Compat rule identifiers. Each maps to a CompatProfile in providerCompatMatrix.ts.
 */
export const CompatRuleSchema = z.enum([
  'cerebras',
  'groq',
  'deepseek',
  'strict-openai',
  'permissive',
])

export type CompatRule = z.infer<typeof CompatRuleSchema>

/**
 * The only supported provider kind for PR-2. Future PR-3+ may add 'oauth', 'bedrock-compat', etc.
 */
export const ProviderKindSchema = z.literal('openai-compat')
export type ProviderKind = z.infer<typeof ProviderKindSchema>

/**
 * Zod schema for a single provider configuration entry.
 *
 * Rules:
 * - id: kebab-case identifier used in /provider use <id>
 * - kind: only 'openai-compat' in PR-2
 * - baseUrl: full base URL including /v1 suffix if needed
 * - apiKeyEnv: name of the env var that holds the API key
 * - defaultModel: model string passed as OPENAI_MODEL
 * - compatRule: selects CompatProfile from providerCompatMatrix
 */
export const ProviderConfigSchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[a-z0-9][a-z0-9:_-]*$/, 'id must be a safe provider id'),
  kind: ProviderKindSchema,
  baseUrl: z.string().url(),
  apiKeyEnv: z.string().min(1).optional(),
  apiKey: z.string().optional(),
  noAuth: z.boolean().optional(),
  timeoutMs: z.number().int().positive().optional(),
  accounts: z
    .array(
      z.object({
        id: z.string().min(1),
        apiKey: z.string().optional(),
        apiKeyEnv: z.string().min(1).optional(),
        /** Optional fixed model for this credential (used by CCB race pools). */
        model: z.string().min(1).optional(),
        enabled: z.boolean().optional(),
        quotaRemaining: z.number().min(0).max(100).optional(),
      }),
    )
    .optional(),
  defaultModel: z.string().min(1),
  compatRule: CompatRuleSchema.default('permissive'),
  /**
   * Highest `reasoning_effort` value this provider accepts. OpenAI-compatible
   * gateways vary: some only go up to `xhigh` (or `high`), and reject `max`
   * with "field ReasoningEffort invalid". When unset we default to `xhigh`,
   * which every known gateway accepts, and clamp higher values down.
   */
  reasoningEffortMax: z.enum(['max', 'xhigh', 'high']).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  /** Quota/billing endpoint (POST) for providers that expose one. */
  usageUrl: z.string().url().optional(),
  models: z.array(z.string().min(1)).optional(),
})

export type ProviderConfig = z.infer<typeof ProviderConfigSchema>

/**
 * Schema for the entire ~/.claude/providers.json file.
 * Top-level must be an array of ProviderConfig.
 */
export const ProvidersFileSchema = z.array(ProviderConfigSchema)
