/**
 * Routing Receipt Emitter — the single emission point on the REAL main
 * request path.
 *
 * Called from `src/query.ts:queryLoop()` immediately after dispatch produces
 * a model. Purely observational: it never returns into the dispatch path,
 * never feeds the router, and cannot change the chosen route.
 *
 * All side-effects are guarded so a logging/observation failure can never
 * break a live request.
 */

import { buildRoutingReceipt } from './receipt-builder';
import type { RoutingContext, RoutingReceipt } from './types';

export interface DispatchOutcome {
  /** Provider id / model string that won. */
  finalModel: string;
  /** Provider family resolved by the adapter, or 'unknown'. */
  provider: string;
  /** Adapter transport actually used. */
  transport: 'anthropic-api' | 'openai-compat' | 'gemini-api' | 'grok-api';
  /**
   * True when the adapter short-circuited the provider-neutral selector and
   * picked a pool on its own — the legacy bypass case the receipt must flag.
   */
  legacyBypass: boolean;
}

export interface EmitContext {
  /** Stable request/scenario discriminator, when the caller has one. */
  requestKind?: string;
  /** Session id (best-effort, empty when unavailable). */
  sessionId?: string;
}

export interface EmissionResult {
  receipt: RoutingReceipt | null;
  /** True only when the receipt was handed to the observation log. */
  observed: boolean;
}

let sink: (receipt: RoutingReceipt) => void = () => {};

export function configureReceiptSink(fn: (receipt: RoutingReceipt) => void): void {
  sink = fn;
}

export function emitRoutingReceipt(
  ctx: RoutingContext,
  outcome: DispatchOutcome,
  emit: EmitContext = {},
): EmissionResult {
  let receipt: RoutingReceipt | null = null;
  try {
    receipt = buildRoutingReceipt(ctx, outcome, emit);
    sink(receipt);
    return { receipt, observed: true };
  } catch {
    // Observability must never break a live request.
    return { receipt: null, observed: false };
  }
}
