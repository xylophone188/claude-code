import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'fs'
import { rename } from 'fs/promises'
import { dirname, join, resolve } from 'path'
import { createHash } from 'crypto'
import { getProjectRoot } from '../bootstrap/state.js'
import { createAgentWorktree } from './worktree.js'
import { buildCliLaunch, spawnCli } from './cliLaunch.js'
import {
  writeDaemonState,
  queryDaemonStatus,
  getDaemonStateFilePath,
} from '../daemon/state.js'

const L5_STATE_VERSION = 1
const L5_WORKTREE_NAME = 'ccb-l5'
const L5_STATE_FILE_NAME = 'l5-state.json'
const L5_LOG_FILE_NAME = 'autonomy-l5.log'
const L5_DAEMON_NAME = 'autonomy-l5'
const L5_WORKER_KIND = 'autonomy'
const MIN_INTERVAL_MS = 5_000
const DEFAULT_INTERVAL_MS = 30_000
const MIN_TURNS = 1
const MAX_TURNS = 200
const DEFAULT_MAX_TURNS = 50
const DEFAULT_MAX_CONSECUTIVE_FAILURES = 3
const DEFAULT_MAX_NO_PROGRESS_TURNS = 3
const DEFAULT_MAX_REVISION_ATTEMPTS = 1
const L5_TIMEOUT_MS = 30 * 60 * 1000
const L5_OUTPUT_LIMIT_BYTES = 1024 * 1024

export type L5Status = 'idle' | 'running' | 'paused' | 'blocked' | 'stopped'

export type L5StopReason =
  | 'user_stop'
  | 'user_pause'
  | 'threshold_failures'
  | 'threshold_no_progress'
  | 'daemon_stop'

export type L5Verdict = 'pass' | 'fail' | 'no_progress' | 'blocked' | 'unknown'

export interface L5State {
  schemaVersion: typeof L5_STATE_VERSION
  enabled: boolean
  status: L5Status
  rootDir: string
  worktreeName: string
  iteration: number
  consecutiveFailures: number
  noProgressTurns: number
  maxConsecutiveFailures: number
  maxNoProgressTurns: number
  maxRevisionAttempts: number
  intervalMs: number
  maxTurnsPerIteration: number
  updatedAt: number
  lastStartedAt: number | null
  lastFinishedAt: number | null
  lastExitCode: number | null
  lastVerdict: L5Verdict
  lastProgressFingerprint: string | null
  lastOutputHash: string | null
  stopReason: L5StopReason | null
  childPid: number | null
}

interface SerializedL5State {
  schemaVersion: number
  enabled?: unknown
  status?: unknown
  rootDir?: unknown
  worktreeName?: unknown
  iteration?: unknown
  consecutiveFailures?: unknown
  noProgressTurns?: unknown
  maxConsecutiveFailures?: unknown
  maxNoProgressTurns?: unknown
  maxRevisionAttempts?: unknown
  intervalMs?: unknown
  maxTurnsPerIteration?: unknown
  updatedAt?: unknown
  lastStartedAt?: unknown
  lastFinishedAt?: unknown
  lastExitCode?: unknown
  lastVerdict?: unknown
  lastProgressFingerprint?: unknown
  lastOutputHash?: unknown
  stopReason?: unknown
  childPid?: unknown
}

function defaultState(rootDir: string): L5State {
  return {
    schemaVersion: L5_STATE_VERSION,
    enabled: false,
    status: 'stopped',
    rootDir,
    worktreeName: L5_WORKTREE_NAME,
    iteration: 0,
    consecutiveFailures: 0,
    noProgressTurns: 0,
    maxConsecutiveFailures: DEFAULT_MAX_CONSECUTIVE_FAILURES,
    maxNoProgressTurns: DEFAULT_MAX_NO_PROGRESS_TURNS,
    maxRevisionAttempts: DEFAULT_MAX_REVISION_ATTEMPTS,
    intervalMs: DEFAULT_INTERVAL_MS,
    maxTurnsPerIteration: DEFAULT_MAX_TURNS,
    updatedAt: Date.now(),
    lastStartedAt: null,
    lastFinishedAt: null,
    lastExitCode: null,
    lastVerdict: 'unknown',
    lastProgressFingerprint: null,
    lastOutputHash: null,
    stopReason: null,
    childPid: null,
  }
}

function clampInteger(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback
  }
  const int = Math.floor(value)
  if (int < min) return min
  if (int > max) return max
  return int
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function asStatus(value: unknown): L5Status | null {
  const allowed: L5Status[] = [
    'idle',
    'running',
    'paused',
    'blocked',
    'stopped',
  ]
  return typeof value === 'string' && allowed.includes(value as L5Status)
    ? (value as L5Status)
    : null
}

function asStopReason(value: unknown): L5StopReason | null {
  const allowed: L5StopReason[] = [
    'user_stop',
    'user_pause',
    'threshold_failures',
    'threshold_no_progress',
    'daemon_stop',
  ]
  return typeof value === 'string' && allowed.includes(value as L5StopReason)
    ? (value as L5StopReason)
    : null
}

function asVerdict(value: unknown): L5Verdict {
  const allowed: L5Verdict[] = [
    'pass',
    'fail',
    'no_progress',
    'blocked',
    'unknown',
  ]
  return typeof value === 'string' && allowed.includes(value as L5Verdict)
    ? (value as L5Verdict)
    : 'unknown'
}

function asNullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.floor(value)
    : null
}

function asNullableString(value: unknown): string | null {
  if (value === null || value === undefined) return null
  return typeof value === 'string' ? value : null
}

function normalizeState(
  rootDir: string,
  raw: SerializedL5State | null,
): L5State {
  const base = defaultState(rootDir)
  if (!raw || typeof raw !== 'object') {
    return base
  }
  const status = asStatus(raw.status)
  const blocked: L5Status = 'blocked'
  const stopped: L5Status = 'stopped'
  const normalizedStatus =
    raw.schemaVersion === L5_STATE_VERSION
      ? (status ?? stopped)
      : asBoolean(raw.enabled, base.enabled)
        ? blocked
        : stopped
  return {
    schemaVersion: L5_STATE_VERSION,
    enabled:
      asBoolean(raw.enabled, base.enabled) && normalizedStatus !== blocked,
    status: normalizedStatus,
    rootDir,
    worktreeName: asNullableString(raw.worktreeName) ?? base.worktreeName,
    iteration: clampInteger(
      raw.iteration,
      0,
      Number.MAX_SAFE_INTEGER,
      base.iteration,
    ),
    consecutiveFailures: clampInteger(
      raw.consecutiveFailures,
      0,
      Number.MAX_SAFE_INTEGER,
      base.consecutiveFailures,
    ),
    noProgressTurns: clampInteger(
      raw.noProgressTurns,
      0,
      Number.MAX_SAFE_INTEGER,
      base.noProgressTurns,
    ),
    maxConsecutiveFailures: clampInteger(
      raw.maxConsecutiveFailures,
      1,
      Number.MAX_SAFE_INTEGER,
      DEFAULT_MAX_CONSECUTIVE_FAILURES,
    ),
    maxNoProgressTurns: clampInteger(
      raw.maxNoProgressTurns,
      1,
      Number.MAX_SAFE_INTEGER,
      DEFAULT_MAX_NO_PROGRESS_TURNS,
    ),
    maxRevisionAttempts: clampInteger(
      raw.maxRevisionAttempts,
      0,
      Number.MAX_SAFE_INTEGER,
      DEFAULT_MAX_REVISION_ATTEMPTS,
    ),
    intervalMs: clampInteger(
      raw.intervalMs,
      MIN_INTERVAL_MS,
      Number.MAX_SAFE_INTEGER,
      DEFAULT_INTERVAL_MS,
    ),
    maxTurnsPerIteration: clampInteger(
      raw.maxTurnsPerIteration,
      MIN_TURNS,
      MAX_TURNS,
      DEFAULT_MAX_TURNS,
    ),
    updatedAt: clampInteger(
      raw.updatedAt,
      0,
      Number.MAX_SAFE_INTEGER,
      Date.now(),
    ),
    lastStartedAt: asNullableNumber(raw.lastStartedAt),
    lastFinishedAt: asNullableNumber(raw.lastFinishedAt),
    lastExitCode: asNullableNumber(raw.lastExitCode),
    lastVerdict: asVerdict(raw.lastVerdict),
    lastProgressFingerprint: asNullableString(raw.lastProgressFingerprint),
    lastOutputHash: asNullableString(raw.lastOutputHash),
    stopReason: asStopReason(raw.stopReason),
    childPid: asNullableNumber(raw.childPid),
  }
}

export function resolveL5StatePath(rootDir: string = getProjectRoot()): string {
  return join(resolve(rootDir), '.claude', 'autonomy', L5_STATE_FILE_NAME)
}

export function resolveL5LogPath(rootDir: string = getProjectRoot()): string {
  return join(resolve(rootDir), '.claude', 'autonomy', L5_LOG_FILE_NAME)
}

export function readL5State(rootDir: string = getProjectRoot()): L5State {
  const filePath = resolveL5StatePath(rootDir)
  try {
    const raw = readFileSync(filePath, 'utf-8')
    const parsed = JSON.parse(raw) as SerializedL5State
    if (
      !parsed ||
      (typeof parsed === 'object' &&
        'schemaVersion' in parsed &&
        parsed.schemaVersion !== L5_STATE_VERSION &&
        asStatus(parsed.status) === null)
    ) {
      return normalizeState(rootDir, parsed)
    }
    return normalizeState(rootDir, parsed)
  } catch {
    return defaultState(rootDir)
  }
}

export function writeL5State(state: L5State): void {
  const filePath = resolveL5StatePath(state.rootDir)
  const dir = dirname(filePath)
  mkdirSync(dir, { recursive: true })
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now().toString(36)}`
  writeFileSync(tmpPath, `${JSON.stringify(state, null, 2)}\n`, 'utf-8')
  try {
    renameSync(tmpPath, filePath)
  } catch {
    rename(tmpPath, filePath).catch(() => {
      try {
        unlinkSync(tmpPath)
      } catch {
        // ignore
      }
    })
  }
}

function renameSync(src: string, dest: string): void {
  try {
    writeFileSync(dest, readFileSync(src))
    unlinkSync(src)
  } catch {
    throw new Error('rename failed')
  }
}

export function onL5(rootDir: string = getProjectRoot()): L5State {
  const state = readL5State(rootDir)
  const next: L5State = {
    ...state,
    enabled: true,
    status: 'idle',
    consecutiveFailures: 0,
    noProgressTurns: 0,
    stopReason: null,
    updatedAt: Date.now(),
  }
  writeL5State(next)
  return next
}

export function pauseL5(rootDir: string = getProjectRoot()): L5State {
  const state = readL5State(rootDir)
  const next: L5State = {
    ...state,
    status: 'paused',
    stopReason: 'user_pause',
    updatedAt: Date.now(),
  }
  writeL5State(next)
  return next
}

export function resumeL5(rootDir: string = getProjectRoot()): L5State {
  const state = readL5State(rootDir)
  if (state.status === 'stopped') {
    return state
  }
  const next: L5State = {
    ...state,
    enabled: true,
    status: 'idle',
    consecutiveFailures: 0,
    noProgressTurns: 0,
    stopReason: null,
    updatedAt: Date.now(),
  }
  writeL5State(next)
  return next
}

export function offL5(rootDir: string = getProjectRoot()): L5State {
  const state = readL5State(rootDir)
  const next: L5State = {
    ...state,
    enabled: false,
    status: 'stopped',
    stopReason: 'user_stop',
    childPid: null,
    updatedAt: Date.now(),
  }
  writeL5State(next)
  return next
}

function beginIteration(state: L5State): L5State {
  return {
    ...state,
    status: 'running',
    childPid: null,
    lastStartedAt: Date.now(),
    updatedAt: Date.now(),
  }
}

function markFailure(
  state: L5State,
  verdict: L5Verdict,
  exitCode: number,
): L5State {
  const failures = state.consecutiveFailures + 1
  const atThreshold = failures >= state.maxConsecutiveFailures
  return {
    ...state,
    status: atThreshold ? 'blocked' : 'idle',
    iteration: state.iteration + 1,
    consecutiveFailures: failures,
    noProgressTurns: 0,
    lastFinishedAt: Date.now(),
    lastExitCode: exitCode,
    lastVerdict: verdict,
    stopReason: atThreshold ? 'threshold_failures' : null,
    childPid: null,
    updatedAt: Date.now(),
  }
}

function markNoProgress(state: L5State): L5State {
  const noProgress = state.noProgressTurns + 1
  const atThreshold = noProgress >= state.maxNoProgressTurns
  return {
    ...state,
    status: atThreshold ? 'blocked' : 'idle',
    iteration: state.iteration + 1,
    noProgressTurns: noProgress,
    lastFinishedAt: Date.now(),
    lastVerdict: 'no_progress',
    stopReason: atThreshold ? 'threshold_no_progress' : null,
    childPid: null,
    updatedAt: Date.now(),
  }
}

function markPass(
  state: L5State,
  fingerprint: string | null,
  outputHash: string | null,
): L5State {
  return {
    ...state,
    status: 'idle',
    iteration: state.iteration + 1,
    consecutiveFailures: 0,
    noProgressTurns: 0,
    lastFinishedAt: Date.now(),
    lastExitCode: 0,
    lastVerdict: 'pass',
    lastProgressFingerprint: fingerprint,
    lastOutputHash: outputHash,
    stopReason: null,
    childPid: null,
    updatedAt: Date.now(),
  }
}

export interface FinishIterationInput {
  state: L5State
  verdict: L5Verdict
  exitCode: number
  fingerprint: string | null
  outputHash: string | null
}

export function finishIteration(input: FinishIterationInput): L5State {
  const { state, verdict, exitCode, fingerprint, outputHash } = input
  if (verdict === 'pass') {
    return markPass(state, fingerprint, outputHash)
  }
  if (verdict === 'no_progress') {
    return markNoProgress(state)
  }
  return markFailure(state, verdict, exitCode)
}

export function canRunL5(state: L5State): boolean {
  if (!state.enabled) return false
  if (state.status !== 'idle') return false
  if (state.consecutiveFailures >= state.maxConsecutiveFailures) return false
  if (state.noProgressTurns >= state.maxNoProgressTurns) return false
  return true
}

export function classifyIterationResult(args: {
  exitCode: number
  hasDiff: boolean
  output: string
}): L5Verdict {
  const trimmed = (args.output || '').trim()
  if (args.exitCode === 0) {
    if (/L5_VERDICT=PASS/i.test(trimmed)) {
      return args.hasDiff ? 'pass' : 'no_progress'
    }
    if (/L5_RESULT=PROGRESS/i.test(trimmed)) {
      return args.hasDiff ? 'pass' : 'no_progress'
    }
    return args.hasDiff ? 'pass' : 'no_progress'
  }
  if (
    /L5_VERDICT=FAIL/i.test(trimmed) ||
    /L5_RESULT=NO_PROGRESS/i.test(trimmed)
  ) {
    return args.hasDiff ? 'fail' : 'no_progress'
  }
  return 'fail'
}

function fingerprintFrom(values: string[]): string {
  const hash = createHash('sha256')
  for (const value of values) {
    hash.update(value)
    hash.update('\0')
  }
  return hash.digest('hex')
}

export function hashFromOutput(output: string): string {
  return createHash('sha256').update(output).digest('hex')
}

export function buildL5StatusText(state: L5State): string {
  const lines = [
    `L5 status: ${state.status}`,
    `Enabled: ${state.enabled}`,
    `Iteration: ${state.iteration}`,
    `Consecutive failures: ${state.consecutiveFailures}/${state.maxConsecutiveFailures}`,
    `No-progress turns: ${state.noProgressTurns}/${state.maxNoProgressTurns}`,
    `Last verdict: ${state.lastVerdict}`,
    `Last exit code: ${state.lastExitCode ?? 'n/a'}`,
    `Last started: ${
      state.lastStartedAt ? new Date(state.lastStartedAt).toISOString() : 'n/a'
    }`,
    `Last finished: ${
      state.lastFinishedAt
        ? new Date(state.lastFinishedAt).toISOString()
        : 'n/a'
    }`,
    `Last progress fingerprint: ${state.lastProgressFingerprint?.slice(0, 8) ?? 'n/a'}`,
    `Last output hash: ${state.lastOutputHash?.slice(0, 8) ?? 'n/a'}`,
    `Stop reason: ${state.stopReason ?? 'none'}`,
    `Updated: ${new Date(state.updatedAt).toISOString()}`,
  ]
  return lines.join('\n')
}

export function readDaemonRootDir(): string | undefined {
  try {
    const path = getDaemonStateFilePath(L5_DAEMON_NAME)
    const raw = readFileSync(path, 'utf-8')
    const parsed = JSON.parse(raw) as { cwd?: string }
    return typeof parsed.cwd === 'string' ? parsed.cwd : undefined
  } catch {
    return undefined
  }
}

export interface SpawnWorkerResult {
  pid: number | null
  started: boolean
  restartRequired: boolean
  reason: string
}

export function ensureAutonomyL5Supervisor(rootDir: string): SpawnWorkerResult {
  const status = queryDaemonStatus(L5_DAEMON_NAME)
  if (status.status === 'running' && status.state) {
    const kinds = status.state.workerKinds || []
    if (kinds.includes(L5_WORKER_KIND)) {
      return {
        pid: status.state.pid,
        started: false,
        restartRequired: false,
        reason: 'already_running',
      }
    }
    return {
      pid: status.state.pid,
      started: false,
      restartRequired: true,
      reason: 'worker_kind_missing',
    }
  }
  try {
    const logPath = resolveL5LogPath(rootDir)
    mkdirSync(dirname(logPath), { recursive: true })
    const logFd = openSync(logPath, 'a')
    const launch = buildCliLaunch(['daemon', 'start', '--dir', rootDir], {
      env: { ...process.env },
    })
    const child = spawnCli(launch, {
      cwd: rootDir,
      detached: true,
      stdio: ['ignore', logFd, logFd],
    })
    child.unref()
    closeSync(logFd)
    writeDaemonState(
      {
        pid: child.pid ?? process.pid,
        cwd: rootDir,
        startedAt: new Date().toISOString(),
        workerKinds: [L5_WORKER_KIND],
        lastStatus: 'running',
      },
      L5_DAEMON_NAME,
    )
    return {
      pid: child.pid ?? null,
      started: true,
      restartRequired: false,
      reason: 'started',
    }
  } catch (error) {
    return {
      pid: null,
      started: false,
      restartRequired: false,
      reason: error instanceof Error ? error.message : 'unknown_error',
    }
  }
}

export function captureWorktreeFingerprint(worktreePath: string): string {
  const parts: string[] = []
  try {
    const status = spawnSyncSafe(
      ['git', 'status', '--porcelain=v1'],
      worktreePath,
    )
    parts.push(status.stdout || '')
  } catch {
    parts.push('')
  }
  try {
    const diff = spawnSyncSafe(['git', 'diff', '--no-ext-diff'], worktreePath)
    parts.push(diff.stdout || '')
  } catch {
    parts.push('')
  }
  return fingerprintFrom(parts)
}

function spawnSyncSafe(
  args: string[],
  cwd: string,
): { stdout: string; code: number } {
  const { spawnSync } =
    require('child_process') as typeof import('child_process')
  const result = spawnSync(args[0], args.slice(1), {
    cwd,
    encoding: 'utf-8',
    maxBuffer: 64 * 1024,
  })
  return {
    stdout: typeof result.stdout === 'string' ? result.stdout : '',
    code: result.status ?? 1,
  }
}

export async function runAutonomyL5Worker(signal: AbortSignal): Promise<void> {
  const rootDir = process.env.DAEMON_WORKER_DIR || resolve('.')
  while (!signal.aborted) {
    const state = readL5State(rootDir)
    if (!state.enabled || state.status === 'stopped') {
      await delay(state.intervalMs, signal)
      continue
    }
    if (state.status === 'paused') {
      await delay(state.intervalMs, signal)
      continue
    }
    if (state.status === 'blocked') {
      await delay(state.intervalMs * 2, signal)
      continue
    }
    if (!canRunL5(state)) {
      await delay(state.intervalMs, signal)
      continue
    }
    const prepared = beginIteration(state)
    writeL5State(prepared)
    const result = await runOneL5Iteration(rootDir, prepared, signal)
    if (result.aborted) {
      writeL5State({
        ...prepared,
        status: 'paused',
        stopReason: 'user_pause',
        childPid: null,
        updatedAt: Date.now(),
      })
      return
    }
    const finished = finishIteration({
      state: prepared,
      verdict: result.verdict,
      exitCode: result.exitCode,
      fingerprint: result.fingerprint,
      outputHash: result.outputHash,
    })
    writeL5State(finished)
    await delay(state.intervalMs, signal)
  }
}

interface IterationResult {
  verdict: L5Verdict
  exitCode: number
  fingerprint: string | null
  outputHash: string | null
  aborted: boolean
  output?: string
}

async function runOneL5Iteration(
  rootDir: string,
  state: L5State,
  signal: AbortSignal,
): Promise<IterationResult> {
  let worktreePath: string | null = null
  try {
    const created = await createAgentWorktree(state.worktreeName)
    worktreePath = created.worktreePath
  } catch (error) {
    return {
      verdict: 'fail',
      exitCode: 1,
      fingerprint: null,
      outputHash: hashFromOutput(String(error)),
      aborted: signal.aborted,
    }
  }
  try {
    const beforeFingerprint = captureWorktreeFingerprint(worktreePath)
    const implementation = await spawnHeadlessIteration(
      rootDir,
      worktreePath,
      state,
      signal,
    )
    if (implementation.aborted) {
      return {
        verdict: 'unknown',
        exitCode: implementation.exitCode,
        fingerprint: null,
        outputHash: null,
        aborted: true,
        output: implementation.output,
      }
    }
    const afterFingerprint = captureWorktreeFingerprint(worktreePath)
    const hasDiff = beforeFingerprint !== afterFingerprint
    const implementationVerdict = classifyIterationResult({
      exitCode: implementation.exitCode,
      hasDiff,
      output: implementation.output,
    })
    if (implementationVerdict === 'pass') {
      return {
        verdict: 'pass',
        exitCode: 0,
        fingerprint: afterFingerprint,
        outputHash: hashFromOutput(implementation.output),
        aborted: false,
      }
    }
    const revisions = Math.max(0, state.maxRevisionAttempts)
    for (let attempt = 0; attempt < revisions; attempt++) {
      const revision = await spawnHeadlessRevision(
        rootDir,
        worktreePath,
        state,
        signal,
      )
      if (revision.aborted) {
        return {
          verdict: 'unknown',
          exitCode: revision.exitCode,
          fingerprint: null,
          outputHash: null,
          aborted: true,
          output: revision.output,
        }
      }
      const revisionVerdict = classifyIterationResult({
        exitCode: revision.exitCode,
        hasDiff: captureWorktreeFingerprint(worktreePath) !== beforeFingerprint,
        output: revision.output,
      })
      if (revisionVerdict === 'pass') {
        break
      }
    }
    const verifier = await spawnHeadlessVerifier(
      rootDir,
      worktreePath,
      state,
      signal,
    )
    if (verifier.aborted) {
      return {
        verdict: 'unknown',
        exitCode: verifier.exitCode,
        fingerprint: null,
        outputHash: null,
        aborted: true,
        output: verifier.output,
      }
    }
    const verifierVerdict = /L5_VERDICT=PASS/i.test(verifier.output)
      ? 'pass'
      : /L5_VERDICT=FAIL/i.test(verifier.output)
        ? 'fail'
        : 'unknown'
    const finalFingerprint = captureWorktreeFingerprint(worktreePath)
    return {
      verdict: verifierVerdict === 'pass' ? 'pass' : 'fail',
      exitCode: verifier.exitCode,
      fingerprint: finalFingerprint,
      outputHash: hashFromOutput(verifier.output),
      aborted: false,
    }
  } catch (error) {
    return {
      verdict: 'fail',
      exitCode: 1,
      fingerprint: null,
      outputHash: hashFromOutput(String(error)),
      aborted: signal.aborted,
    }
  }
}

function buildL5Env(worktreePath: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CCB_L5_ACTIVE: '1',
    CCB_FORCE_ADVISOR_WORKFLOW: '0',
    CCB_L5_WORKTREE: worktreePath,
  }
}

function spawnHeadlessIteration(
  rootDir: string,
  worktreePath: string,
  state: L5State,
  signal: AbortSignal,
): Promise<{ output: string; exitCode: number; aborted: boolean }> {
  return spawnHeadlessCli({
    rootDir,
    worktreePath,
    state,
    signal,
    mode: 'implementation',
  })
}

function spawnHeadlessRevision(
  rootDir: string,
  worktreePath: string,
  state: L5State,
  signal: AbortSignal,
): Promise<{ output: string; exitCode: number; aborted: boolean }> {
  return spawnHeadlessCli({
    rootDir,
    worktreePath,
    state,
    signal,
    mode: 'revision',
  })
}

function spawnHeadlessVerifier(
  rootDir: string,
  worktreePath: string,
  state: L5State,
  signal: AbortSignal,
): Promise<{ output: string; exitCode: number; aborted: boolean }> {
  return spawnHeadlessCli({
    rootDir,
    worktreePath,
    state,
    signal,
    mode: 'verification',
  })
}

interface SpawnRequest {
  rootDir: string
  worktreePath: string
  state: L5State
  signal: AbortSignal
  mode: 'implementation' | 'revision' | 'verification'
}

async function spawnHeadlessCli(req: SpawnRequest): Promise<{
  output: string
  exitCode: number
  aborted: boolean
}> {
  const prompt = l5PromptForMode(req.mode)
  const args = [
    '-p',
    prompt,
    '--permission-mode',
    'auto',
    '--model',
    'auto',
    '--max-turns',
    String(
      Math.max(MIN_TURNS, Math.min(MAX_TURNS, req.state.maxTurnsPerIteration)),
    ),
    '--output-format',
    'json',
    '--no-session-persistence',
  ]
  const launch = buildCliLaunch(args, { env: buildL5Env(req.worktreePath) })
  return await new Promise(resolve => {
    let output = ''
    let settled = false
    const finish = (exitCode: number, aborted: boolean) => {
      if (settled) return
      settled = true
      resolve({ output, exitCode, aborted })
    }
    const child = spawnCli(launch, {
      cwd: req.worktreePath,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: buildL5Env(req.worktreePath),
    })
    const onAbort = () => {
      try {
        child.kill('SIGTERM')
      } catch {
        // ignore
      }
    }
    req.signal.addEventListener('abort', onAbort, { once: true })
    if (child.stdout) {
      child.stdout.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf-8')
        const remaining = L5_OUTPUT_LIMIT_BYTES - output.length
        if (remaining <= 0) return
        output += text.slice(0, remaining)
      })
    }
    if (child.stderr) {
      child.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString('utf-8')
        const remaining = L5_OUTPUT_LIMIT_BYTES - output.length
        if (remaining <= 0) return
        output += text.slice(0, remaining)
      })
    }
    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM')
      } catch {
        // ignore
      }
      setTimeout(() => {
        if (!settled) {
          try {
            child.kill('SIGKILL')
          } catch {
            // ignore
          }
        }
      }, 5_000).unref()
    }, L5_TIMEOUT_MS)
    timer.unref()
    child.on('exit', code => {
      clearTimeout(timer)
      req.signal.removeEventListener('abort', onAbort)
      finish(code ?? 1, req.signal.aborted)
    })
    child.on('error', () => {
      clearTimeout(timer)
      req.signal.removeEventListener('abort', onAbort)
      finish(1, req.signal.aborted)
    })
  })
}

function l5PromptForMode(
  mode: 'implementation' | 'revision' | 'verification',
): string {
  if (mode === 'verification') {
    return [
      'You are the L5 autonomous verifier. Read the current code changes, run targeted tests, typecheck, and lint using the project standard commands. Do not edit files, do not commit, do not push, do not deploy, and do not restart services.',
      'Finish with exactly one final line: L5_VERDICT=PASS if all gates pass, otherwise L5_VERDICT=FAIL.',
    ].join(' ')
  }
  if (mode === 'revision') {
    return [
      'You are the L5 autonomous reviser. Fix the failing verification gates from the previous iteration using the smallest safe change. Do not commit, do not push, do not deploy, and do not restart services.',
      'Finish with exactly one final line: L5_VERDICT=PASS if fixed, otherwise L5_VERDICT=FAIL.',
    ].join(' ')
  }
  return [
    'You are the L5 autonomous worker for CCB. Pick exactly one bounded, evidence-backed task from the repository (prefer a stable test failure or a reliability bug). Preserve existing uncommitted work; optimize only with before/after measurements.',
    'Run at least one targeted test and the project typecheck/lint gates. Do not commit, do not push, do not merge, do not deploy, do not restart services, and do not delete user files or change credentials or permissions.',
    'Finish with exactly one final line: L5_RESULT=PROGRESS if you made verifiable progress, L5_RESULT=NO_PROGRESS if there was nothing safe to do, or L5_RESULT=BLOCKED if blocked.',
  ].join(' ')
}

async function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return
  await new Promise<void>(resolve => {
    const timer = setTimeout(() => resolve(), ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
    timer.unref?.()
  })
}
