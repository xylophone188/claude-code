/**
 * Pure utility functions for building OpenAI request bodies and detecting
 * thinking mode. Extracted from index.ts so tests can import them without
 * triggering heavy module side-effects (OpenAI client, stream adapter, etc.).
 */
import type { ChatCompletionCreateParamsStreaming } from 'openai/resources/chat/completions/completions.mjs'
import { asSystemPrompt, type SystemPrompt } from '@ant/model-provider'
import { isEnvTruthy, isEnvDefinedFalsy } from '../../../utils/envUtils.js'
import { findProvider } from '../../providerRegistry/loader.js'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * CodeBuddy CN applies its own content filter to system prompts that advertise
 * an agent identity; replace such prompts with a neutral one (ported from
 * 9router's open-sse/executors/codebuddy-cn.js). Matches on length or pattern.
 */
const NEUTRAL_PROMPT =
  'You are a helpful AI assistant that helps with software engineering tasks.'

const AGENT_PATTERN =
  /you are claude code|claude.?code.+official.+cli|anthropic.+official.+cli|anxthxropic.+official.+cli|you are (?:cursor|windsurf|cline|aider|continue|copilot|cody)|you are an? (?:ai )?(?:coding |code )?agent|cc_entrypoint\s*=\s*(?:cli|vscode|jetbrains|gui)|claude.?code.+issues|give feedback.+claude.?code|you are .{0,30}(?:powerful )?ai agent|orchestration capabilities|OhMyOpenCode|<agent-identity>|<Role>|<Behavior_Instructions>/i

/**
 * Neutralize a system prompt for CodeBuddy CN: long or agent-identity-bearing
 * prompts are replaced with a single neutral engineering-assistant prompt,
 * everything else passes through unchanged. Returns the same SystemPrompt shape.
 */
export function neutralizeSystemPrompt(prompt: SystemPrompt): SystemPrompt {
  const text = prompt.join('\n')
  if (text.length > 2000 || AGENT_PATTERN.test(text)) {
    return asSystemPrompt([NEUTRAL_PROMPT])
  }
  return prompt
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map(block => {
      if (!block || typeof block !== 'object') return ''
      const part = block as Record<string, unknown>
      if (typeof part.content === 'string') return part.content
      if (typeof part.text === 'string') return part.text
      return JSON.stringify(part)
    })
    .join('\n')
}

/**
 * Tencent's CodeBuddy endpoint rejects agent system prompts, `tool` messages,
 * and non-text assistant blocks. Keep this transport-specific rewrite here so
 * every CodeBuddy route, including auto fallbacks, sends an accepted body.
 */
export function sanitizeCodeBuddyRequestBody(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...body }
  if (Array.isArray(result.messages)) {
    result.messages = result.messages.flatMap(message => {
      if (!message || typeof message !== 'object') return []
      const item = message as Record<string, unknown>
      if (item.role === 'tool') {
        const text = contentToText(item.content)
        return text ? [{ role: 'user', content: text }] : []
      }
      if (item.role === 'assistant' && Array.isArray(item.content)) {
        const content = item.content.flatMap(part => {
          if (!part || typeof part !== 'object') return []
          const block = part as Record<string, unknown>
          if (block.type === 'text' || block.type === 'image_url')
            return [block]
          const text = contentToText([block])
          return text ? [{ type: 'text', text }] : []
        })
        return [{ ...item, content: content.length ? content : null }]
      }
      if (item.role === 'system') {
        const text = contentToText(item.content)
        if (text.length > 2000 || AGENT_PATTERN.test(text)) {
          return [
            {
              ...item,
              content:
                typeof item.content === 'string'
                  ? NEUTRAL_PROMPT
                  : [{ type: 'text', text: NEUTRAL_PROMPT }],
            },
          ]
        }
      }
      return [item]
    })
  }
  if (result.reasoning_effort === 'none' || result.reasoning_effort === 'off') {
    delete result.reasoning_effort
    delete result.reasoning_summary
  } else if (result.reasoning_effort) {
    result.reasoning_summary = 'auto'
  }
  return result
}

/**
 * Detect whether thinking mode should be enabled for this model.
 *
 * Enabled when:
 * 1. OPENAI_ENABLE_THINKING=1 is set (explicit enable), OR
 * 2. Model name contains "deepseek" or "mimo" (auto-detect, case-insensitive)
 *
 * Disabled when:
 * - OPENAI_ENABLE_THINKING=0/false/no/off is explicitly set (overrides model detection)
 *
 * @param model - The resolved OpenAI model name
 */
export function isOpenAIThinkingEnabled(model: string): boolean {
  // Explicit disable takes priority (overrides model auto-detect)
  if (isEnvDefinedFalsy(process.env.OPENAI_ENABLE_THINKING)) return false
  // Explicit enable
  if (isEnvTruthy(process.env.OPENAI_ENABLE_THINKING)) return true
  // Auto-detect from model name (DeepSeek and MiMo models support thinking mode).
  // Grok is intentionally excluded — Grok reasoning models reason automatically
  // and do NOT require thinking/enable_thinking request body parameters.
  const modelLower = model.toLowerCase()
  return modelLower.includes('deepseek') || modelLower.includes('mimo')
}

/**
 * Per-provider `reasoning_effort` capability. OpenAI-compatible gateways are
 * inconsistent about which values they accept:
 *   - OpenCode Zen honors `max`
 *   - some gateways only go up to `xhigh` (reject `max` with
 *     "field ReasoningEffort invalid, should be one of: low, medium, high,
 *     xhigh, none")
 *   - others (e.g. gemma / agnes via sglang) accept `max` but NOT `xhigh`
 *     ("should be 'none', 'low', 'medium', 'high' or 'max'")
 *
 * The only value present in EVERY observed accepted-set is `high`, so that is
 * the safe default. Providers that support more declare it via
 * `reasoningEffortMax` (or, for opencode, are hard-coded to `max`). Exported
 * so callers (and tests) can verify the exact value each route will send
 * without opening a network stream.
 */
export const REASONING_EFFORT_ORDER = [
  'none',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const

export function providerReasoningEffortCap(
  providerId: string | undefined,
): 'max' | 'xhigh' | 'high' {
  // The provider config's `reasoningEffortMax` is the source of truth: once a
  // cap is solidified into providers.json (e.g. by scripts/l1-probe.ts) we no
  // longer depend on the on-disk probe cache below. This is what keeps the
  // request path from relying solely on ~/.ccb-embed/reasoningCaps.json.
  const provider = providerId ? findProvider(providerId) : undefined
  const declared = provider?.reasoningEffortMax
  if (declared === 'max' || declared === 'xhigh' || declared === 'high')
    return declared
  if (providerId === 'opencode') return 'max'
  // Fallback: a probe run (`scripts/l1-probe.ts`) may have persisted each
  // provider's real accepted ceiling here. Used only when config is silent.
  const override = readReasoningCaps()[providerId ?? '']
  if (override === 'max' || override === 'xhigh' || override === 'high')
    return override
  return 'high'
}

/**
 * On-disk cache of per-provider `reasoning_effort` ceilings discovered by the
 * L1 probe script. Keyed by providerId; values are 'max' | 'xhigh' | 'high'.
 * Missing file / bad JSON falls back to the built-in default gracefully.
 */
export const REASONING_CAPS_PATH = join(
  homedir(),
  '.ccb-embed',
  'reasoningCaps.json',
)
let reasoningCapsCache: Record<string, string> | null | undefined
export function readReasoningCaps(): Record<string, string> {
  if (reasoningCapsCache !== undefined) return reasoningCapsCache ?? {}
  try {
    if (existsSync(REASONING_CAPS_PATH)) {
      const parsed = JSON.parse(readFileSync(REASONING_CAPS_PATH, 'utf8'))
      if (parsed && typeof parsed === 'object') {
        reasoningCapsCache = parsed as Record<string, string>
        return reasoningCapsCache
      }
    }
  } catch {
    // ignore — fall through to empty cache
  }
  reasoningCapsCache = {}
  return reasoningCapsCache
}

/** Clamp an effort value down to the highest level a provider accepts. */
export function clampReasoningEffort(
  providerId: string | undefined,
  effort: string | undefined,
): string | undefined {
  if (!effort) return effort
  const effortIdx = REASONING_EFFORT_ORDER.indexOf(
    effort as (typeof REASONING_EFFORT_ORDER)[number],
  )
  if (effortIdx === -1) return effort
  const cap = providerReasoningEffortCap(providerId)
  const capIdx = REASONING_EFFORT_ORDER.indexOf(cap)
  return effortIdx <= capIdx ? effort : cap
}

/**
 * Resolve max output tokens for the OpenAI-compatible path.
 *
 * Override priority:
 * 1. maxOutputTokensOverride (programmatic, from query pipeline)
 * 2. OPENAI_MAX_TOKENS env var (OpenAI-specific, useful for local models
 *    with small context windows, e.g. RTX 3060 12GB running 65536-token models)
 * 3. CLAUDE_CODE_MAX_OUTPUT_TOKENS env var (generic override)
 * 4. upperLimit default (64000)
 */
export function resolveOpenAIMaxTokens(
  upperLimit: number,
  maxOutputTokensOverride?: number,
): number {
  return (
    maxOutputTokensOverride ??
    (process.env.OPENAI_MAX_TOKENS
      ? parseInt(process.env.OPENAI_MAX_TOKENS, 10) || undefined
      : undefined) ??
    (process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS
      ? parseInt(process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, 10) || undefined
      : undefined) ??
    upperLimit
  )
}

/**
 * Build the request body for OpenAI chat.completions.create().
 * Extracted for testability — the thinking mode params are injected here.
 *
 * Three thinking-mode formats are sent simultaneously; each endpoint uses the
 * format it recognizes and ignores the others:
 * - Official DeepSeek API:    `thinking: { type: 'enabled' }`
 * - Self-hosted DeepSeek:     `enable_thinking: true` + `chat_template_kwargs: { thinking: true }`
 * - MiMo (Xiaomi):            `chat_template_kwargs: { enable_thinking: true }`
 * OpenAI SDK passes unknown keys through to the HTTP body.
 */
export function buildOpenAIRequestBody(params: {
  model: string
  messages: any[]
  tools: any[]
  toolChoice: any
  enableThinking: boolean
  maxTokens: number
  /** Resolved effort level (low/medium/high/xhigh/max) sent as reasoning_effort. */
  reasoningEffort?: string
  /** CodeBuddy CN reasoning opt-in (#2071): sent only with reasoning_effort. */
  reasoningSummary?: string
  temperatureOverride?: number
  /** Session-scoped routing key for official OpenAI requests. */
  promptCacheKey?: string
}): ChatCompletionCreateParamsStreaming & {
  thinking?: { type: string }
  enable_thinking?: boolean
  chat_template_kwargs?: { thinking: boolean; enable_thinking: boolean }
  /** OpenAI prompt-cache routing key (not always in SDK types yet). */
  prompt_cache_key?: string
  /** OpenAI-compatible reasoning effort; honored by OpenCode Zen / DeepSeek. */
  reasoning_effort?: string
  /** CodeBuddy CN reasoning summary opt-in (only alongside reasoning_effort). */
  reasoning_summary?: string
} {
  const {
    model,
    messages,
    tools,
    toolChoice,
    enableThinking,
    maxTokens,
    reasoningEffort,
    reasoningSummary,
    temperatureOverride,
    promptCacheKey,
  } = params
  return {
    model,
    messages,
    max_tokens: maxTokens,
    ...(promptCacheKey && { prompt_cache_key: promptCacheKey }),
    ...(tools.length > 0 && {
      tools,
      ...(toolChoice && { tool_choice: toolChoice }),
    }),
    stream: true,
    stream_options: { include_usage: true },
    // OpenAI-compatible reasoning effort (honored by OpenCode Zen / DeepSeek).
    // Not sent alongside thinking-mode params: endpoints pick the format they know.
    // The actual value is clamped per-provider in createRouteStream so providers
    // that don't accept `max` get the highest value they do accept.
    ...(reasoningEffort && { reasoning_effort: reasoningEffort }),
    // CodeBuddy CN requires reasoning_summary whenever reasoning_effort is sent
    // (#2071); without it the content filter rejects the request.
    ...(reasoningSummary && { reasoning_summary: reasoningSummary }),
    // Enable chain-of-thought output for DeepSeek and MiMo models.
    // When active, temperature/top_p/presence_penalty/frequency_penalty are ignored.
    ...(enableThinking && {
      // Official DeepSeek API format
      thinking: { type: 'enabled' },
      // Self-hosted DeepSeek-V3.2 format
      enable_thinking: true,
      // Both DeepSeek self-hosted and MiMo formats in chat_template_kwargs
      chat_template_kwargs: { thinking: true, enable_thinking: true },
    }),
    // Only send temperature when thinking mode is off (DeepSeek ignores it anyway,
    // but other providers may respect it)
    ...(!enableThinking &&
      temperatureOverride !== undefined && {
        temperature: temperatureOverride,
      }),
  }
}

/** NVIDIA's Chat Completions endpoint accepts only low/medium/high effort. */
export function sanitizeNvidiaRequestBody(
  body: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...body }
  if (
    result.reasoning_effort === 'max' ||
    result.reasoning_effort === 'xhigh'
  ) {
    result.reasoning_effort = 'high'
  }
  return result
}
