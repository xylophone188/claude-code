/**
 * ccbRouting / fusion — answer-fusion utilities for the "fusion" combo strategy.
 *
 * Mirrors the ccb `fusion` combo (parallel panel + judge), but kept PURE: no
 * network, no DB, no provider ids. Just text in, text out. `panel-x` (combos.ts)
 * is the canonical fusion combo this backs.
 */

export interface PanelAnswer {
  model: string
  text: string
}

const HEADING_RE = /^#{1,6}\s+\S/m
const BULLET_RE = /^\s*(?:[-*+]\s|\d+[.)]\s)/m

/**
 * scoreStructure — a simple, deterministic structure score for a piece of text.
 *
 * Combines counts of structural markers (headings, fenced code blocks, bullet
 * list items) with a length signal that is normalized (capped) so a long but
 * unstructured wall of text does not dominate a compact, well-structured answer.
 *
 * Pure: text only.
 */
export function scoreStructure(text: string): number {
  if (!text) return 0

  const lines = text.split('\n')

  let headings = 0
  let codeFences = 0
  let bullets = 0
  for (const line of lines) {
    if (HEADING_RE.test(line)) headings++
    if (line.trim().startsWith('```')) codeFences++
    if (BULLET_RE.test(line)) bullets++
  }
  // Each fenced block has an opening and closing delimiter.
  const codeBlocks = Math.floor(codeFences / 2)

  // Structural markers are weighted to dominate; length is capped normalization.
  const markers = headings * 2 + codeBlocks * 2 + bullets
  const lengthNorm = Math.min(text.length / 1000, 3)

  return markers + lengthNorm
}

function tokenize(text: string): Set<string> {
  const tokens = new Set<string>()
  for (const m of text.toLowerCase().matchAll(/[a-z0-9]+/g)) {
    tokens.add(m[0])
  }
  return tokens
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1
  if (a.size === 0 || b.size === 0) return 0
  let inter = 0
  for (const t of a) if (b.has(t)) inter++
  const union = a.size + b.size - inter
  return union === 0 ? 0 : inter / union
}

/**
 * fuseAnswers — fuse a panel of model answers under the given strategy.
 *
 * - 'best' (default): return the text of the answer with the highest structure score.
 * - 'concat': join every answer with a separator and a per-model label.
 * - 'vote': return the answer most similar (token-overlap Jaccard) to the majority
 *   of the others (consensus); falls back to 'best' on ties or empty input.
 *
 * Pure: text only, no network/DB, no provider ids.
 */
export function fuseAnswers(
  answers: PanelAnswer[],
  strategy: 'best' | 'concat' | 'vote' = 'best',
): string {
  if (!answers || answers.length === 0) return ''
  if (answers.length === 1) return answers[0].text

  if (strategy === 'concat') {
    const SEP = '\n\n' + '-'.repeat(24) + '\n\n'
    return answers.map(a => `[${a.model}]:\n${a.text}`).join(SEP)
  }

  if (strategy === 'vote') {
    const tokenSets = answers.map(a => tokenize(a.text))
    const totals = answers.map((_, i) => {
      let sum = 0
      for (let j = 0; j < answers.length; j++) {
        if (i === j) continue
        sum += jaccard(tokenSets[i], tokenSets[j])
      }
      return sum
    })
    let bestIdx = 0
    let bestVal = -1
    let tie = false
    for (let i = 0; i < totals.length; i++) {
      if (totals[i] > bestVal) {
        bestVal = totals[i]
        bestIdx = i
        tie = false
      } else if (totals[i] === bestVal) {
        tie = true
      }
    }
    if (tie || bestVal === 0) {
      // Fall back to 'best' on ties (or when nothing is similar to anything).
      return fuseAnswers(answers, 'best')
    }
    return answers[bestIdx].text
  }

  // strategy === 'best' (default)
  let bestIdx = 0
  let bestScore = -1
  for (let i = 0; i < answers.length; i++) {
    const s = scoreStructure(answers[i].text)
    if (s > bestScore) {
      bestScore = s
      bestIdx = i
    }
  }
  return answers[bestIdx].text
}
