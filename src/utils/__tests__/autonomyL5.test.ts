import { expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import {
  readL5State,
  writeL5State,
  onL5,
  pauseL5,
  resumeL5,
  offL5,
  canRunL5,
  classifyIterationResult,
  finishIteration,
  buildL5StatusText,
  hashFromOutput,
  resolveL5StatePath,
} from '../autonomyL5.js'

let tempRoot = ''

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'autonomyL5-test-'))
})

afterEach(() => {
  try {
    rmSync(tempRoot, { recursive: true, force: true })
  } catch {
    // ignore
  }
})

test('readL5State returns defaults for missing file', () => {
  const state = readL5State(tempRoot)
  expect(state.enabled).toBe(false)
  expect(state.status).toBe('stopped')
  expect(state.iteration).toBe(0)
  expect(state.consecutiveFailures).toBe(0)
  expect(state.noProgressTurns).toBe(0)
})

test('readL5State returns safe defaults for corrupt JSON', () => {
  const statePath = resolveL5StatePath(tempRoot)
  const dir = statePath.slice(0, statePath.lastIndexOf('/'))
  const fs = require('fs')
  fs.mkdirSync(dir, { recursive: true })
  writeFileSync(statePath, '{bad json', 'utf-8')
  const state = readL5State(tempRoot)
  expect(state.status).toBe('stopped')
  expect(state.enabled).toBe(false)
})

test('readL5State normalizes unsupported schema version to blocked', () => {
  const statePath = resolveL5StatePath(tempRoot)
  const fs = require('fs')
  fs.mkdirSync(statePath.slice(0, statePath.lastIndexOf('/')), {
    recursive: true,
  })
  writeFileSync(
    statePath,
    JSON.stringify({ schemaVersion: 999, enabled: true }),
    'utf-8',
  )
  const state = readL5State(tempRoot)
  expect(state.status).toBe('blocked')
  expect(state.enabled).toBe(false)
})

test('writeL5State creates file and dir', () => {
  const state = readL5State(tempRoot)
  const updated = { ...state, enabled: true, status: 'idle' as const }
  writeL5State(updated)
  const written = readL5State(tempRoot)
  expect(written.enabled).toBe(true)
  expect(written.status).toBe('idle')
})

test('writeL5State is atomic (no partial file on read)', () => {
  const state = readL5State(tempRoot)
  writeL5State({ ...state, enabled: true, status: 'idle' as const })
  const content = readFileSync(resolveL5StatePath(tempRoot), 'utf-8')
  const parsed = JSON.parse(content)
  expect(parsed.schemaVersion).toBe(1)
  expect(parsed.enabled).toBe(true)
})

test('onL5 enables and returns idle', () => {
  const state = onL5(tempRoot)
  expect(state.enabled).toBe(true)
  expect(state.status).toBe('idle')
  const persisted = readL5State(tempRoot)
  expect(persisted.enabled).toBe(true)
})

test('pauseL5 sets paused status', () => {
  onL5(tempRoot)
  const state = pauseL5(tempRoot)
  expect(state.status).toBe('paused')
  expect(state.stopReason).toBe('user_pause')
})

test('resumeL5 clears failures and goes idle', () => {
  const state = onL5(tempRoot)
  writeL5State({ ...state, consecutiveFailures: 2, noProgressTurns: 1 })
  const resumed = resumeL5(tempRoot)
  expect(resumed.status).toBe('idle')
  expect(resumed.consecutiveFailures).toBe(0)
  expect(resumed.noProgressTurns).toBe(0)
  expect(resumed.stopReason).toBeNull()
})

test('resumeL5 no-ops when stopped', () => {
  const state = offL5(tempRoot)
  expect(state.status).toBe('stopped')
  const resumed = resumeL5(tempRoot)
  expect(resumed.status).toBe('stopped')
})

test('offL5 disables and sets stopped', () => {
  onL5(tempRoot)
  const state = offL5(tempRoot)
  expect(state.enabled).toBe(false)
  expect(state.status).toBe('stopped')
  expect(state.stopReason).toBe('user_stop')
})

test('canRunL5 requires enabled + idle + no threshold breaches', () => {
  const base = readL5State(tempRoot)
  expect(canRunL5({ ...base, enabled: false, status: 'idle' })).toBe(false)
  expect(canRunL5({ ...base, enabled: true, status: 'stopped' })).toBe(false)
  expect(canRunL5({ ...base, enabled: true, status: 'paused' })).toBe(false)
  expect(canRunL5({ ...base, enabled: true, status: 'blocked' })).toBe(false)
  expect(canRunL5({ ...base, enabled: true, status: 'idle' })).toBe(true)
  expect(
    canRunL5({
      ...base,
      enabled: true,
      status: 'idle',
      consecutiveFailures: 3,
    }),
  ).toBe(false)
  expect(
    canRunL5({ ...base, enabled: true, status: 'idle', noProgressTurns: 3 }),
  ).toBe(false)
})

test('classifyIterationResult with diff and exit 0 → pass', () => {
  const result = classifyIterationResult({
    exitCode: 0,
    hasDiff: true,
    output: 'ok',
  })
  expect(result).toBe('pass')
})

test('classifyIterationResult with diff but exit 0 and no progress marker → no_progress', () => {
  const result = classifyIterationResult({
    exitCode: 0,
    hasDiff: true,
    output: 'ok',
  })
  expect(result).toBe('pass')
})

test('classifyIterationResult without diff and exit 0 → no_progress', () => {
  const result = classifyIterationResult({
    exitCode: 0,
    hasDiff: false,
    output: 'ok',
  })
  expect(result).toBe('no_progress')
})

test('classifyIterationResult with L5_RESULT=PROGRESS and diff → pass', () => {
  const result = classifyIterationResult({
    exitCode: 0,
    hasDiff: true,
    output: 'L5_RESULT=PROGRESS',
  })
  expect(result).toBe('pass')
})

test('classifyIterationResult with exit non-0 → fail', () => {
  const result = classifyIterationResult({
    exitCode: 1,
    hasDiff: false,
    output: 'error',
  })
  expect(result).toBe('fail')
})

test('classifyIterationResult with L5_RESULT=NO_PROGRESS and no diff → no_progress', () => {
  const result = classifyIterationResult({
    exitCode: 0,
    hasDiff: false,
    output: 'L5_RESULT=NO_PROGRESS',
  })
  expect(result).toBe('no_progress')
})

test('finishIteration pass resets failures', () => {
  const state = readL5State(tempRoot)
  const failed = { ...state, consecutiveFailures: 2, noProgressTurns: 1 }
  const result = finishIteration({
    state: failed,
    verdict: 'pass',
    exitCode: 0,
    fingerprint: 'abc',
    outputHash: 'def',
  })
  expect(result.consecutiveFailures).toBe(0)
  expect(result.noProgressTurns).toBe(0)
  expect(result.iteration).toBe(1)
  expect(result.lastProgressFingerprint).toBe('abc')
})

test('finishIteration fail increments consecutiveFailures', () => {
  const state = readL5State(tempRoot)
  const result = finishIteration({
    state,
    verdict: 'fail',
    exitCode: 1,
    fingerprint: null,
    outputHash: null,
  })
  expect(result.consecutiveFailures).toBe(1)
  expect(result.iteration).toBe(1)
})

test('finishIteration fail at threshold → blocked', () => {
  const state = readL5State(tempRoot)
  const failed = { ...state, consecutiveFailures: 2 }
  const result = finishIteration({
    state: failed,
    verdict: 'fail',
    exitCode: 1,
    fingerprint: null,
    outputHash: null,
  })
  expect(result.status).toBe('blocked')
  expect(result.stopReason).toBe('threshold_failures')
})

test('finishIteration no_progress increments noProgressTurns', () => {
  const state = readL5State(tempRoot)
  const result = finishIteration({
    state,
    verdict: 'no_progress',
    exitCode: 0,
    fingerprint: null,
    outputHash: null,
  })
  expect(result.noProgressTurns).toBe(1)
  expect(result.iteration).toBe(1)
})

test('finishIteration no_progress at threshold → blocked', () => {
  const state = readL5State(tempRoot)
  const noProgress = { ...state, noProgressTurns: 2 }
  const result = finishIteration({
    state: noProgress,
    verdict: 'no_progress',
    exitCode: 0,
    fingerprint: null,
    outputHash: null,
  })
  expect(result.status).toBe('blocked')
  expect(result.stopReason).toBe('threshold_no_progress')
})

test('buildL5StatusText contains key fields', () => {
  const state = readL5State(tempRoot)
  const text = buildL5StatusText(state)
  expect(text).toContain('L5 status: stopped')
  expect(text).toContain('Enabled: false')
  expect(text).toContain('Iteration: 0')
})

test('hashFromOutput is deterministic', () => {
  const h1 = hashFromOutput('test')
  const h2 = hashFromOutput('test')
  expect(h1).toBe(h2)
  expect(h1).toMatch(/^[a-f0-9]{64}$/)
})

test('state does not contain prompt/objective/diff fields', () => {
  const state = onL5(tempRoot)
  const json = JSON.stringify(state)
  expect(json).not.toMatch(/prompt/i)
  expect(json).not.toMatch(/objective/i)
  expect(json).not.toMatch(/diff/i)
})

test('clampInteger normalizes out-of-range values', () => {
  const state = onL5(tempRoot)
  writeL5State({ ...state, intervalMs: -1, maxTurnsPerIteration: 9999 })
  const read = readL5State(tempRoot)
  expect(read.intervalMs).toBe(5000)
  expect(read.maxTurnsPerIteration).toBe(200)
})

test('state file exists and is valid JSON after write', () => {
  onL5(tempRoot)
  const statePath = resolveL5StatePath(tempRoot)
  const content = readFileSync(statePath, 'utf-8')
  const parsed = JSON.parse(content)
  expect(parsed.schemaVersion).toBe(1)
  expect(typeof parsed.status).toBe('string')
})
