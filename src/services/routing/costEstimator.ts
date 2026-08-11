/**
 * CCB costEstimator — pure token-cost estimation.
 *
 * Uses CCB's direct routing prices. Prices are approximate/nominal
 * per-1M-token rates keyed on known model ids (same ids used by resolveProvider).
 *
 * PURE: no network, no DB, no mutable state. Safe to call anywhere.
 */
import { resolveProvider } from './resolve.js'

/** Per-1M-token prices (USD) keyed on known model ids. */
export const PRICING: Record<string, { in: number; out: number }> = {
  'openai/gpt-5.4': { in: 5, out: 15 },
  'xai/grok-4': { in: 5, out: 15 },
  'kimi/kimi-k3': { in: 1, out: 3 },
  'deepseek/deepseek-v4-pro': { in: 1, out: 2 },
  'groq/llama-3.3-70b-versatile': { in: 0.2, out: 0.2 },
}

export interface CostBreakdown {
  inputCost: number
  outputCost: number
  total: number
  currency: 'USD'
  model: string
}

/** Raw pricing lookup; unknown ids resolve to {in:0,out:0} (free). */
export function priceFor(id: string): { in: number; out: number } {
  return PRICING[id] ?? { in: 0, out: 0 }
}

/**
 * Estimate cost for a model spec.
 *
 * Resolves the spec via resolveProvider (when it matches a known provider id)
 * to obtain the canonical id, then looks up PRICING and computes
 *   inputCost  = (price.in  / 1e6) * promptTokens
 *   outputCost = (price.out / 1e6) * completionTokens
 * Unknown specs are treated as zero cost.
 */
export function estimateCost(
  modelOrSpec: string,
  promptTokens: number,
  completionTokens: number,
): CostBreakdown {
  const provider = resolveProvider(modelOrSpec)
  const id = provider?.id ?? modelOrSpec
  const price = priceFor(id)

  const inputCost = (price.in / 1e6) * promptTokens
  const outputCost = (price.out / 1e6) * completionTokens
  const total = inputCost + outputCost

  return {
    inputCost,
    outputCost,
    total,
    currency: 'USD',
    model: id,
  }
}
