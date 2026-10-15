/**
 * Immutable "unique multi-factor model selection" shadow receipt.
 *
 * Emitted ONCE on the real dispatch path (directQuery/directOpenAIQuery +
 * QueryEngine→queryLoop) purely for auditability. It MUST NOT influence
 * routing: it is a pure side-effect read of the resolved scenario, profile
 * version, and legacy selected route. Unknown scenarios map to
 * `default@v1` (never `coding`).
 */

export type ShadowScenario =
  | 'coding'
  | 'analysis'
  | 'writing'
  | 'design'
  | 'default'

export type FactorVersion = {
  stateVersion: string | null
  scoreVersion: string | null
}

export type ModelSelectionShadowReceipt = {
  scenario: ShadowScenario
  scenarioOrigin: 'resolved' | 'unknown'
  profileVersion: string
  factorVersion: FactorVersion
  routingSnapshot: 'unavailable'
  candidateRanking: 'legacy' | 'unavailable'
  legacySelectedRoute: 'direct_query' | 'direct_openai_query' | 'query_loop'
  bypassDetected: boolean
  emittedAt: string
}

const UNKNOWN_SCENARIO = 'default'
const UNKNOWN_PROFILE_VERSION = 'default@v1'

export type ModelProfileShadowReceiptInput = {
  legacySelectedRoute: ModelSelectionShadowReceipt['legacySelectedRoute']
  bypassDetected: boolean
  resolvedScenario?: unknown
  profileVersion?: unknown
  stateVersion?: unknown
  scoreVersion?: unknown
}

export function makeModelSelectionShadowReceipt(
  input: ModelProfileShadowReceiptInput,
): ModelSelectionShadowReceipt {
  const scenario =
    input.resolvedScenario === 'coding' ||
    input.resolvedScenario === 'analysis' ||
    input.resolvedScenario === 'writing' ||
    input.resolvedScenario === 'design'
      ? input.resolvedScenario
      : UNKNOWN_SCENARIO
  const profileVersion =
    typeof input.profileVersion === 'string' && input.profileVersion.length > 0
      ? input.profileVersion
      : UNKNOWN_PROFILE_VERSION
  return {
    scenario,
    scenarioOrigin:
      input.resolvedScenario === scenario ? 'resolved' : 'unknown',
    profileVersion,
    factorVersion: {
      stateVersion:
        typeof input.stateVersion === 'string' && input.stateVersion.length > 0
          ? input.stateVersion
          : null,
      scoreVersion:
        typeof input.scoreVersion === 'string' && input.scoreVersion.length > 0
          ? input.scoreVersion
          : null,
    },
    routingSnapshot: 'unavailable',
    candidateRanking: 'legacy',
    legacySelectedRoute: input.legacySelectedRoute,
    bypassDetected: input.bypassDetected,
    emittedAt: new Date().toISOString(),
  }
}

export const MODEL_SELECTION_SHADOW_RECEIPT: {
  emit: (
    receipt: ModelSelectionShadowReceipt,
    context: string,
    bypassDetected: boolean,
  ) => void
} = {
  emit(
    receipt: ModelSelectionShadowReceipt,
    context: string,
    bypassDetected: boolean,
  ): void {
    if (!process.env.CCB_SHADOW_RECEIPT_DEBUG) return
    console.error(
      `[shadow-receipt][${context}] scenario=${receipt.scenario} origin=${receipt.scenarioOrigin} profile=${receipt.profileVersion} route=${receipt.legacySelectedRoute} bypass=${String(bypassDetected)}`,
    )
  },
}
