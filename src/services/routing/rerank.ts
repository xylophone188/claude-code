/**
 * ccbRouting / rerank — pure reranking for candidate models/answers.
 *
 * Used by ccb to rerank candidates:
 *   - numeric `score` present  -> sort desc by score
 *   - no scores but `query`    -> sort desc by term-overlap relevance
 *   - neither                  -> stable original order
 *
 * PURE: no network, no DB, no global mutable state. Safe to call anywhere.
 */

export interface RerankItem {
  id: string
  score?: number
  text?: string
}

/** Count shared tokens between two strings (case-insensitive, split on non-word chars). */
export function termOverlap(a: string, b: string): number {
  if (!a || !b) return 0
  const tokens = (s: string): Set<string> =>
    new Set(
      s
        .toLowerCase()
        .split(/\W+/)
        .filter(t => t.length > 0),
    )
  const ta = tokens(a)
  const tb = tokens(b)
  if (ta.size === 0 || tb.size === 0) return 0
  let shared = 0
  for (const t of ta) {
    if (tb.has(t)) shared++
  }
  return shared
}

/** Rerank items by score, term-overlap with query, or stable order. */
export function rerank(items: RerankItem[], query?: string): RerankItem[] {
  if (items.length === 0) return []

  const hasScores = items.some(it => typeof it.score === 'number')

  if (hasScores) {
    return [...items].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
  }

  if (
    query &&
    query.length > 0 &&
    items.some(it => typeof it.text === 'string')
  ) {
    return [...items].sort(
      (a, b) =>
        termOverlap(b.text ?? '', query) - termOverlap(a.text ?? '', query),
    )
  }

  return [...items]
}
