import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { appendFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

export type RaceMetric = {
  at: string
  provider: string
  model: string
  account: string
  outcome: 'selected' | 'won' | 'cancelled' | 'failed'
  elapsedMs: number
  ttftMs?: number
  outputChars?: number
  streamEvents?: number
  toolCalls?: number
  status?: number
}

const MAX_METRICS_BYTES = 256 * 1024
let cachedPreferences:
  | { path: string; mtimeMs: number; preferences: Map<string, number> }
  | undefined

function metricsPath(): string {
  return (
    process.env.CCB_RACE_METRICS_FILE ??
    join(homedir(), '.ccb-embed', 'race-metrics.jsonl')
  )
}

function readableLogPath(): string {
  return (
    process.env.CCB_RACE_LOG_FILE ??
    process.env.CCB_REAL_LOG ??
    join(homedir(), '.ccb-embed', 'ccb-real.log')
  )
}

function readableMetric(metric: RaceMetric): string {
  const extras = [
    metric.ttftMs === undefined ? undefined : `ttftMs=${metric.ttftMs}`,
    metric.status === undefined ? undefined : `status=${metric.status}`,
  ].filter((value): value is string => value !== undefined)
  return `[routing] [race-metric] ${metric.outcome} ${metric.provider}/${metric.model} account=${metric.account} elapsedMs=${metric.elapsedMs}${extras.length ? ` ${extras.join(' ')}` : ''}`
}

function readMetricsTail(path: string): string {
  const { size } = statSync(path)
  const length = Math.min(size, MAX_METRICS_BYTES)
  const buffer = Buffer.alloc(length)
  const file = openSync(path, 'r')
  try {
    readSync(file, buffer, 0, length, size - length)
  } finally {
    closeSync(file)
  }
  const text = buffer.toString('utf8')
  return size > length ? text.slice(text.indexOf('\n') + 1) : text
}

/** Small persisted bias: recent successful, fast contenders stay ahead; failed
 * routes drift back. It never replaces live health or quota scoring. */
export function getRaceMetricPreferences(): ReadonlyMap<string, number> {
  const path = metricsPath()
  try {
    const { mtimeMs } = statSync(path)
    if (
      cachedPreferences?.path === path &&
      cachedPreferences.mtimeMs === mtimeMs
    )
      return cachedPreferences.preferences
    const totals = new Map<
      string,
      { selected: number; failed: number; ttftMs: number }
    >()
    for (const line of readMetricsTail(path).trim().split('\n')) {
      try {
        const metric = JSON.parse(line) as RaceMetric
        if (!metric.provider || !metric.model) continue
        const key = `${metric.provider}/${metric.model}`
        const total = totals.get(key) ?? { selected: 0, failed: 0, ttftMs: 0 }
        if (metric.outcome === 'selected') {
          total.selected++
          total.ttftMs += metric.ttftMs ?? metric.elapsedMs
        } else if (metric.outcome === 'failed') total.failed++
        totals.set(key, total)
      } catch {
        // A partial final line is normal while another request appends.
      }
    }
    const preferences = new Map(
      [...totals].map(([key, total]) => {
        const attempts = total.selected + total.failed
        const reliability = attempts ? total.selected / attempts - 0.5 : 0
        const averageTtft = total.selected
          ? total.ttftMs / total.selected
          : 10_000
        const speed = Math.max(0, 1 - averageTtft / 10_000) - 0.5
        return [key, reliability * 0.1 + speed * 0.05]
      }),
    )
    cachedPreferences = { path, mtimeMs, preferences }
    return preferences
  } catch {
    return new Map()
  }
}

/** Best-effort local telemetry; never contains prompts, responses, or API keys. */
export function recordRaceMetric(metric: RaceMetric): void {
  const line = `${JSON.stringify(metric)}\n`
  const readableLine = `${readableMetric(metric)}\n`
  const metrics = metricsPath()
  const readable = readableLogPath()
  void Promise.all([
    mkdir(dirname(metrics), { recursive: true }).then(() =>
      appendFile(metrics, line, { mode: 0o600 }),
    ),
    mkdir(dirname(readable), { recursive: true }).then(() =>
      appendFile(readable, readableLine, { mode: 0o600 }),
    ),
  ]).catch(() => undefined)
}
