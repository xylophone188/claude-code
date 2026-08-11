import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getRaceMetricPreferences, recordRaceMetric } from '../raceMetrics.js'

test('prefers recent fast winners over failed contenders', () => {
  const directory = mkdtempSync(join(tmpdir(), 'race-metrics-'))
  const path = join(directory, 'metrics.jsonl')
  const previous = process.env.CCB_RACE_METRICS_FILE
  process.env.CCB_RACE_METRICS_FILE = path
  writeFileSync(
    path,
    [
      {
        provider: 'fast',
        model: 'model',
        outcome: 'selected',
        elapsedMs: 50,
        ttftMs: 50,
      },
      { provider: 'slow', model: 'model', outcome: 'failed', elapsedMs: 5000 },
    ]
      .map(metric => JSON.stringify(metric))
      .join('\n'),
  )
  try {
    const preferences = getRaceMetricPreferences()
    expect(preferences.get('fast/model')).toBeGreaterThan(0)
    expect(preferences.get('slow/model')).toBeLessThan(0)
  } finally {
    if (previous === undefined) delete process.env.CCB_RACE_METRICS_FILE
    else process.env.CCB_RACE_METRICS_FILE = previous
    rmSync(directory, { recursive: true, force: true })
  }
})

test('writes readable race events without relying on the launcher stderr tee', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'race-metrics-'))
  const metrics = join(directory, 'metrics.jsonl')
  const readable = join(directory, 'ccb-real.log')
  const previousMetrics = process.env.CCB_RACE_METRICS_FILE
  const previousReadable = process.env.CCB_RACE_LOG_FILE
  process.env.CCB_RACE_METRICS_FILE = metrics
  process.env.CCB_RACE_LOG_FILE = readable
  try {
    recordRaceMetric({
      at: new Date().toISOString(),
      provider: 'test-provider',
      model: 'test-model',
      account: 'test-account',
      outcome: 'failed',
      elapsedMs: 321,
      status: 429,
    })
    for (let i = 0; i < 20; i++) {
      try {
        const log = readFileSync(readable, 'utf8')
        expect(log).toContain(
          '[routing] [race-metric] failed test-provider/test-model',
        )
        expect(log).toContain('status=429')
        return
      } catch {
        await Bun.sleep(5)
      }
    }
    throw new Error('race log was not written')
  } finally {
    if (previousMetrics === undefined) delete process.env.CCB_RACE_METRICS_FILE
    else process.env.CCB_RACE_METRICS_FILE = previousMetrics
    if (previousReadable === undefined) delete process.env.CCB_RACE_LOG_FILE
    else process.env.CCB_RACE_LOG_FILE = previousReadable
    rmSync(directory, { recursive: true, force: true })
  }
})
