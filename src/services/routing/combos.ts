/**
 * ccbRouting / combos — default combo set + alias map.
 *
 * Ports the combo + alias concepts from ccb:
 *   - open-sse/services/combo.js   (strategies: fallback / fusion / sticky-round-robin)
 *   - open-sse/services/model.js    (alias -> provider/model or combo)
 *
 * All model strings use the canonical "provider/model" form and MUST reference ids that
 * exist in CCB_ROUTING_PROVIDERS (see registry.generated.ts).
 */
import type { CCBRoutingCombo, CCBRoutingAlias } from './types.js'
import { CCB_ROUTING_ALIASES_GENERATED } from './aliases.generated.js'

/**
 * Default combos. `advisor-combo` is the fallback chain backing the virtual "advisor"
 * model (mirrors advisor.ts ADVISOR_COMBO_NAME). Strong coding models first, cheaper
 * fallbacks later. `fast-rr` demonstrates sticky-round-robin selection. `panel-x`
 * demonstrates fusion (parallel panel + judge).
 */
export const CCB_ROUTING_COMBOS: CCBRoutingCombo[] = [
  {
    name: 'advisor-combo',
    strategy: 'fallback',
    models: [
      'openai/gpt-5.4',
      'xai/grok-4',
      'kimi/kimi-k3',
      'deepseek/deepseek-v4-pro',
    ],
  },
  // Four-tier advisor (lite / full / ultra / review). Each tier is a curated
  // fallback chain; `full` mirrors the default advisor-combo. Selecting a tier
  // is explicit via the model string (e.g. /model lite) — see aliases below.
  {
    name: 'advisor-lite',
    strategy: 'fallback',
    models: ['deepseek/deepseek-v4-pro', 'kimi/kimi-k3'],
  },
  {
    name: 'advisor-full',
    strategy: 'fallback',
    models: [
      'openai/gpt-5.4',
      'xai/grok-4',
      'kimi/kimi-k3',
      'deepseek/deepseek-v4-pro',
    ],
  },
  {
    name: 'advisor-ultra',
    strategy: 'fallback',
    models: ['openai/gpt-5.4', 'xai/grok-4'],
  },
  {
    name: 'advisor-review',
    strategy: 'fallback',
    models: ['kimi/kimi-k3', 'deepseek/deepseek-v4-pro', 'openai/gpt-5.4'],
  },
  {
    name: 'fast-rr',
    strategy: 'sticky-round-robin',
    stickyLimit: 3,
    models: [
      'groq/llama-3.3-70b-versatile',
      'deepseek/deepseek-v4-pro',
      'openai/gpt-5.4',
    ],
  },
  {
    name: 'panel-x',
    strategy: 'fusion',
    models: ['openai/gpt-5.4', 'xai/grok-4', 'kimi/kimi-k3'],
  },
]

/**
 * Useful short-name aliases. Alias targets may be "provider/model" (resolved to a
 * concrete provider+model) or a combo name (resolved to the combo).
 */
export const CCB_ROUTING_ALIASES: CCBRoutingAlias[] = [
  { alias: 'advisor', target: 'advisor-combo' },
  { alias: 'lite', target: 'advisor-lite' },
  { alias: 'full', target: 'advisor-full' },
  { alias: 'ultra', target: 'advisor-ultra' },
  { alias: 'review', target: 'advisor-review' },
  { alias: 'opus', target: 'openai/gpt-5.4' },
  { alias: 'smart', target: 'openai/gpt-5.4' },
  { alias: 'code', target: 'kimi/kimi-k3' },
  { alias: 'rr', target: 'fast-rr' },
  { alias: 'panel', target: 'panel-x' },
  ...CCB_ROUTING_ALIASES_GENERATED,
]
