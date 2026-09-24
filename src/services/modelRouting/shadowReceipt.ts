/**
 * Shadow selection receipt — V8 §4.2 "Selection Receipt" minimal vertical slice.
 *
 * Non-mutating. Called only from the single authoritative main-model selection
 * boundary. Produces an immutable receipt used for observability only; never
 * affects dispatch.
 *
 * Constraints enforced:
 * - No candidate reordering.
 * - No pool membership change.
 * - No retry/refresh/pick fallback on receipt failure.
 * - No receipt on transport/provider paths (would cause pool re-selection).
 */

export const SCENARIO_PROFILES_VERSION = 'v1' as const

export const SCENARIO_CATALOG_VERSION = 'v0.1' as const

const KNOWN_SCENARIOS = new Set<string>([
  'coding',
  'research',
  'analysis',
  'planning',
  'review',
  'debug',
  'operations',
  'content',
  'writing',
  'qa',
])

export type ScenarioProfileVersion = typeof SCENARIO_PROFILES_VERSION

export type KnownScenario =
  | 'coding'
  | 'research'
  | 'analysis'
  | 'planning'
  | 'review'
  | 'debug'
  | 'operations'
  | 'content'
  | 'writing'
  | 'qa'

export type Scenario = KnownScenario | 'unknown'
export type ScenarioOrigin = 'known' | 'unknown'

/**
 * V0.1 catalog is a stub: it only declares that scenarios are known.
 * Factor versions and ranked candidates are intentionally unavailable.
 * Any code reading them must handle the `unavailable` state.
 */
export interface ScenarioProfile {
  version: ScenarioProfileVersion
  allowedModelFamilies: string[]
  factorVersion: { factors: string; version: string }
  rankedCandidates: { id: string; score: number }[]
  bypassSignatures: string[]
}

function makeProfile(): ScenarioProfile {
  return {
    version: SCENARIO_PROFILES_VERSION,
    allowedModelFamilies: [],
    factorVersion: { factors: 'unavailable', version: 'unavailable' },
    rankedCandidates: [],
    bypassSignatures: [],
  }
}

const PROFILES: Record<KnownScenario, ScenarioProfile> = {
  coding: makeProfile(),
  research: makeProfile(),
  analysis: makeProfile(),
  planning: makeProfile(),
  review: makeProfile(),
  debug: makeProfile(),
  operations: makeProfile(),
  content: makeProfile(),
  writing: makeProfile(),
  qa: makeProfile(),
}

export function getScenarioProfile(
  scenario: Scenario,
): ScenarioProfile | null {
  if (scenario === 'unknown') return null
  return PROFILES[scenario] ?? null
}

export function normalizeScenario(value: unknown): {
  scenario: Scenario
  origin: ScenarioOrigin
} {
  if (typeof value === 'string' && KNOWN_SCENARIOS.has(value)) {
    return { scenario: value as KnownScenario, origin: 'known' }
  }
  // Anything else — including `undefined`, `null`, empty string, garbage,
  // or future scenario names not yet in the catalog — is `unknown`.
  // Never coerce to `coding` as a default.
  return { scenario: 'unknown', origin: 'unknown' }
}

export interface SelectionReceiptInput {
  scenario?: string | null
  selectedRouteId?: string | null
  legacySelectedRoute?: {
    routeId: string
    provider?: string
    model?: string
  } | null
  factorSnapshot?: string | null
  candidateSummary?: string | null
  bypassDetected?: boolean
}

export interface SelectionReceipt {
  scenario: Scenario
  scenarioOrigin: ScenarioOrigin
  profileVersion: ScenarioProfileVersion
  scenarioCatalogVersion: typeof SCENARIO_CATALOG_VERSION
  factorVersion: string
  factorSnapshot: string
  candidateSummary: string
  legacySelectedRoute: string
  bypassDetected: boolean
  nonMutating: true
}

export function buildSelectionReceipt(
  input: SelectionReceiptInput,
): SelectionReceipt {
  const { scenario, origin } = normalizeScenario(input.scenario)
  const profile = getScenarioProfile(scenario)
  return {
    scenario,
    scenarioOrigin: origin,
    profileVersion: profile?.version ?? SCENARIO_PROFILES_VERSION,
    scenarioCatalogVersion: SCENARIO_CATALOG_VERSION,
    factorVersion:
      profile?.factorVersion.factors ?? 'unavailable',
    factorSnapshot:
      input.factorSnapshot ?? 'unavailable',
    candidateSummary:
      input.candidateSummary ?? 'legacy-unavailable',
    legacySelectedRoute:
      input.legacySelectedRoute?.routeId ??
      input.selectedRouteId ??
      'unavailable',
    bypassDetected: input.bypassDetected === true,
    nonMutating: true,
  }
}

export interface EmitContext {
  selectedRouteId?: string | null
  legacySelectedRoute?: {
    routeId: string
    provider?: string
    model?: string
  } | null
  factorSnapshot?: string | null
  candidateSummary?: string | null
}

export function emitSelectionReceipt(
  scenario: string | null | undefined,
  ctx: EmitContext,
): void {
  const receipt = buildSelectionReceipt({
    scenario,
    ...ctx,
  })
  // Non-blocking diagnostic sink. Receipt is immutable — nothing downstream
  // may mutate it or use it to influence routing.
  // biome-ignore lint/suspicious/noConsole: shadow receipt observability
  console.log('[shadow-receipt]', JSON.stringify(receipt))
}
