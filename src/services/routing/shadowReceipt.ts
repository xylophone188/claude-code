// Shadow Receipt — minimal vertical slice on the real model-selection path.
//
// Emission is metadata-only: it NEVER changes provider, model, or dispatch.
// The only side effect is one structured debug line per turn plus an
// in-memory ring buffer for tests / future sinks.
//
// Contract (docs/CCB_V8_ARCHITECTURE.md §7, docs/SCENARIOS_TAXONOMY.md §6):
// - Known scenario: metadata ONLY; transport must not re-select by pool for this.
// - Unknown scenario: MUST be `default@v1`, NEVER `coding`.
// - Factor snapshots and candidate rankings may only be reported `unavailable`
//   when the real inputs are not yet present on this path.

import { createHash } from 'crypto'

/**
 * Every unknown/unclassified request collapses to this single scenario id.
 *
 * `coding` is intentionally NOT the fallback: it is a real v8 scenario id, and
 * silently relabeling unrecognized traffic as coding is exactly the failure
 * mode this receipt exists to surface.
 */
export const SHADOW_RECEIPT_DEFAULT_SCENARIO = 'default@v1'

/** Stable id of the scenario-profile vocabulary this receipt speaks. */
export const SHADOW_RECEIPT_PROFILE_VERSION = 'shadow-receipt-v1'

/** Scenario ids the taxonomy can currently prove from this path. */
export const KNOWN_SHADOW_SCENARIOS: readonly string[] = ['coding', 'review']

export type ShadowReceiptUnavailableReason = 'unavailable' | 'legacy'

/** A single factor version, or an explicit unavailability declaration. */
export interface ShadowReceiptFactorVersion {
  id: string
  version: string
}

export type ShadowReceiptFactorState =
  | { kind: 'versions'; factors: ShadowReceiptFactorVersion[] }
  | { kind: 'unavailable'; reason: ShadowReceiptUnavailableReason }

/** One entry of the candidate ranking summary. */
export interface ShadowReceiptCandidateSummary {
  rank: number
  model: string
  score?: number
  source?: string
}

export type ShadowReceiptCandidateState =
  | { kind: 'ranking'; candidates: ShadowReceiptCandidateSummary[] }
  | { kind: 'unavailable'; reason: ShadowReceiptUnavailableReason }

/**
 * The legacy selection that actually decided provider + model. Reported
 * verbatim; never computed by the receipt.
 */
export interface ShadowReceiptSelectedRoute {
  provider: string
  model: string
}

/**
 * Which legacy path wrote `model` / `provider` — the bypass detector.
 *
 * Determined by *provenance*, not by string matching: the hook runs
 * immediately after selection, so the receipt records which selector was
 * last to write the value on this path.
 */
export type ShadowReceiptRouteType =
  | 'provider'
  | 'model'
  | 'advisor'
  | 'auto-routing'
  | 'openai'
  | 'gemini'
  | 'grok'
  | 'bedrock'
  | 'vertex'
  | 'direct'

/**
 * Immutable record of one model-selection decision on the real main request
 * path. Created via {@link makeShadowReceipt} and deeply frozen.
 */
export interface ShadowReceipt {
  readonly scenario: string
  /** 'metadata-only': known, so nothing may act on it. */
  readonly scenarioOrigin: 'metadata-only'
  readonly profileVersion: string
  readonly factors: ShadowReceiptFactorState
  readonly candidates: ShadowReceiptCandidateState
  readonly legacySelectedRoute: ShadowReceiptSelectedRoute
  readonly bypassDetected: boolean
  readonly bypassRouteType: ShadowReceiptRouteType | null
  readonly selectedAt: string
  /** sha256 over canonical JSON of every other field. Tamper-evident. */
  readonly integrityHash: string
}

export interface ShadowReceiptInput {
  provider: string
  model: string
  /** Provenance: which selector most recently wrote provider/model. */
  selector: ShadowReceiptRouteType
  /** Nulls collapse to {@link SHADOW_RECEIPT_DEFAULT_SCENARIO}. */
  scenario?: string | null
  /** Only meaningful when `scenario` is a known id. */
  scenarioOrigin?: string | null
  factors?: ShadowReceiptFactorState
  candidates?: ShadowReceiptCandidateState
}

/**
 * RFC-7159-style canonical JSON: object keys sorted lexicographically, no
 * whitespace, no float formatting. Guarantees `hash(canonicalize(x))` is
 * stable regardless of object literal key insertion order.
 */
function canonicalize(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>
    const keys = Object.keys(obj).sort()
    return `{${keys.map(k => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function hashIntegrity(receipt: Omit<ShadowReceipt, 'integrityHash'>): string {
  return createHash('sha256').update(canonicalize(receipt)).digest('hex')
}

function deepFreeze<T extends object>(obj: T): T {
  Object.freeze(obj)
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') deepFreeze(v as object)
  }
  return obj
}

/** Build an immutable, frozen receipt. Pure: no I/O, no mutation. */
export function buildShadowReceipt(
  input: ShadowReceiptInput,
  now = new Date().toISOString(),
): ShadowReceipt {
  const scenario = input.scenario ?? SHADOW_RECEIPT_DEFAULT_SCENARIO
  const bypassDetected = input.selector !== 'provider'

  const body = {
    scenario,
    scenarioOrigin: 'metadata-only' as const,
    profileVersion: SHADOW_RECEIPT_PROFILE_VERSION,
    factors: input.factors ?? {
      kind: 'unavailable' as const,
      reason: 'legacy' as const,
    },
    candidates: input.candidates ?? {
      kind: 'unavailable' as const,
      reason: 'legacy' as const,
    },
    legacySelectedRoute: {
      provider: input.provider,
      model: input.model,
    },
    bypassDetected,
    bypassRouteType: bypassDetected ? input.selector : null,
    selectedAt: now,
  }
  const receipt = { ...body, integrityHash: hashIntegrity(body) }
  return deepFreeze(receipt)
}

/** Create and freeze a receipt. The only constructor callers should use. */
export function makeShadowReceipt(
  input: ShadowReceiptInput,
  now?: string,
): ShadowReceipt {
  return buildShadowReceipt(input, now)
}

/** Stable single-line rendering for debug logs / tests. */
export function formatShadowReceipt(receipt: ShadowReceipt): string {
  const factors =
    receipt.factors.kind === 'versions'
      ? receipt.factors.factors.map(f => `${f.id}@${f.version}`).join(',')
      : `${receipt.factors.reason}`
  const candidates =
    receipt.candidates.kind === 'ranking'
      ? receipt.candidates.candidates
          .map(c => {
            const score = c.score === undefined ? '' : `:${c.score}`
            const src = c.source === undefined ? '' : `@${c.source}`
            return `#${c.rank}${c.model}${score}${src}`
          })
          .join('|')
      : `${receipt.candidates.reason}`

  return (
    `scenario=${receipt.scenario}` +
    ` profileVersion=${receipt.profileVersion}` +
    ` origin=${receipt.scenarioOrigin}` +
    ` factors=[${factors}]` +
    ` candidates=[${candidates}]` +
    ` route=${receipt.legacySelectedRoute.provider}:${receipt.legacySelectedRoute.model}` +
    ` bypass=${receipt.bypassDetected}` +
    ` bypassType=${receipt.bypassRouteType ?? 'none'}` +
    ` selectedAt=${receipt.selectedAt}` +
    ` hash=${receipt.integrityHash.slice(0, 12)}`
  )
}

// --- In-memory ring buffer (bounded, for tests + future sinks) -------------

const RING_MAX = 128
const ring: ShadowReceipt[] = []

function pushToRing(r: ShadowReceipt): void {
  ring.push(r)
  if (ring.length > RING_MAX) ring.shift()
}

/** Test/inspection hook — read-only view of the ring. */
export function getShadowReceiptLog(): readonly ShadowReceipt[] {
  return ring
}

/** Test-only reset. */
export function resetShadowReceiptEmitLog(): void {
  ring.length = 0
}

/**
 * Build a receipt and log it on the real selection path.
 *
 * The return value is ignored by callers: this function is a strict observer.
 * Deriving any provider/model decision from it is a contract violation.
 */
export function emitShadowReceipt(
  input: ShadowReceiptInput,
  now = new Date().toISOString(),
): ShadowReceipt {
  const receipt = buildShadowReceipt(input, now)
  pushToRing(receipt)
  return receipt
}
