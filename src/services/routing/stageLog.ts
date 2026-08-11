/**
 * Stage-gated routing diagnostics for the CCB auto-routing chain.
 *
 * CCB_STAGE controls how much the routing path emits to stderr:
 *   - dev → full diagnostics (connection scans, probes, scores, choices)
 *   - prd → errors only; diagnostics stay available but normal requests remain
 *     quiet enough for interactive use.
 *
 * Per-session override: CCB_STAGE=dev ccb
 *
 * Format (matches the ccb-embed proxy / router log style for tail -F
 * alignment across the three log files):
 *   <ISO-timestamp> [routing] [stage] message suffix
 *
 * Two overloads:
 *   - routeLog(stage, message, ...args) — new style, explicit stage.
 *   - routeLog(message, ...args)        — legacy single-message form. The
 *     bracketed stage tag becomes `[misc]` and the message is the inline
 *     label, so existing callers compile unchanged.
 *
 * routeError is unchanged.
 */

import { formatLocalTimestamp, repairUtf8 } from '../../utils/encoding.js'

// Read at call-time so CCB_STAGE can flip per process invocation without rebuild.
// In bundled dist the module is evaluated once, but `process.env` is a live
// reference — flipping the env var on the next `ccb` invocation works as expected.
export function isDevStage(): boolean {
  return (process.env.CCB_STAGE ?? 'prd') === 'dev'
}

type RouteStage =
  | 'candidates'
  | 'conn'
  | 'probe'
  | 'score'
  | 'rank'
  | 'pick'
  | 'request'
  | 'race'
  | 'retry'
  | 'misc'
  | 'error'

function formatSuffix(args: unknown[]): string {
  return args
    .map(a => {
      if (typeof a === 'string') return a
      try {
        return JSON.stringify(a)
      } catch {
        return String(a)
      }
    })
    .join(' ')
}

function nowIso(): string {
  // Local timezone, `yyyy-MM-dd HH:mm:ss.SSS` — see formatLocalTimestamp.
  return formatLocalTimestamp()
}

function writeLine(prefix: string, message: string, args: unknown[]): void {
  const suffix = formatSuffix(args)
  const line = `${nowIso()} ${prefix}${message ? ` ${message}` : ''}${suffix ? ` ${suffix}` : ''}`
  // Repair any double-encoded UTF-8 that upstream sources may have emitted
  // (e.g. external hook subprocesses) so the log file stays valid UTF-8.
  process.stderr.write(`${repairUtf8(line)}\n`)
}

/** New-style: explicit stage tag. */
export function routeLog(
  stage: RouteStage,
  message: string,
  ...args: unknown[]
): void
/** Legacy single-arg form. Tag falls back to [misc] for old callers. */
export function routeLog(message: string, ...args: unknown[]): void
export function routeLog(
  stageOrMessage: string,
  messageOrArg?: string | unknown,
  ...rest: unknown[]
): void {
  if (!isDevStage() && stageOrMessage !== 'error') return
  const known = new Set<RouteStage>([
    'candidates',
    'conn',
    'probe',
    'score',
    'rank',
    'pick',
    'request',
    'race',
    'retry',
    'misc',
    'error',
  ])
  if (known.has(stageOrMessage as RouteStage)) {
    const message = typeof messageOrArg === 'string' ? messageOrArg : ''
    writeLine(`[routing] [${stageOrMessage}]`, message, rest)
    return
  }
  const message = stageOrMessage
  writeLine(`[routing] [misc]`, message, [messageOrArg, ...rest])
}

/**
 * Log a routing failure/fallback line. Emitted at any stage (including the
 * default prd) because failures like HTTP 404 or timeouts must be traceable
 * to the provider/model/status that produced them.
 */
export function routeError(message: string, ...args: unknown[]): void {
  writeLine(`[routing] [error]`, message, args)
}
