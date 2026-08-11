#!/usr/bin/env bun
import {
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import {
  collectLogAuditEvents,
  emptyLogAuditState,
  type LogAuditState,
} from '../src/services/ccbRouter/logAudit.js'

const root = process.env.CCB_LOG_AUDIT_ROOT ?? process.cwd()
const dataDir = process.env.CCB_LOG_AUDIT_DIR ?? join(homedir(), '.ccb-embed')
const statePath =
  process.env.CCB_LOG_AUDIT_STATE ?? join(dataDir, 'log-audit-state.json')
const logPaths = (
  process.env.CCB_LOG_AUDIT_LOGS ??
  [join(dataDir, 'ccb-real.log'), join(dataDir, 'router.log')].join(',')
)
  .split(',')
  .map(value => value.trim())
  .filter(Boolean)
const maxEvents = Math.max(
  1,
  Number(process.env.CCB_LOG_AUDIT_MAX_EVENTS) || 20,
)

async function readState(): Promise<LogAuditState> {
  try {
    const parsed = JSON.parse(
      await readFile(statePath, 'utf8'),
    ) as LogAuditState
    return parsed?.version === 1 && parsed.files && parsed.fingerprints
      ? parsed
      : emptyLogAuditState()
  } catch {
    return emptyLogAuditState()
  }
}

async function saveState(state: LogAuditState): Promise<void> {
  await mkdir(dirname(statePath), { recursive: true })
  const temporary = `${statePath}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600 })
  await rename(temporary, statePath)
}

async function withLock<T>(run: () => Promise<T>): Promise<T | undefined> {
  const lockPath = `${statePath}.lock`
  await mkdir(dirname(lockPath), { recursive: true })
  let handle
  try {
    handle = await open(lockPath, 'wx', 0o600)
  } catch {
    console.info('[ccb-log-audit] another audit is running; skipped')
    return undefined
  }
  try {
    return await run()
  } finally {
    await handle.close()
    await unlink(lockPath).catch(() => undefined)
  }
}

function advisorPrompt(
  events: Awaited<ReturnType<typeof collectLogAuditEvents>>,
): string {
  const report = events
    .map(event => `- ${event.level.toUpperCase()} ${event.text}`)
    .join('\n')
  return `You are CCB's hourly incident advisor. Start the built-in Workflow tool with mode="advisor" for these fresh, redacted events. Diagnose only them and fix a confirmed CCB source-code root cause when safe; auto does the work and advisor performs final acceptance. Run focused verification. Do not change credentials, user data, systemd units, network proxy/Clash, external services, or files outside ${resolve(root)}. If no safe code fix exists, classify the event and state the smallest next action.\n\n${report}`
}

async function runAdvisor(
  events: Awaited<ReturnType<typeof collectLogAuditEvents>>,
): Promise<number> {
  const command =
    process.env.CCB_LOG_AUDIT_COMMAND ?? join(homedir(), '.local/bin/ccb')
  const child = spawn(
    command,
    ['--model', 'advisor', '-p', advisorPrompt(events)],
    {
      cwd: resolve(root),
      stdio: 'inherit',
      env: { ...process.env, CCB_LOG_AUDIT_RUN: '1' },
    },
  )
  return await new Promise(resolveChild =>
    child.once('exit', code => resolveChild(code ?? 1)),
  )
}

await withLock(async () => {
  const state = await readState()
  const events = (
    await Promise.all(logPaths.map(path => collectLogAuditEvents(path, state)))
  )
    .flat()
    .slice(0, maxEvents)
  await saveState(state)
  if (!events.length) {
    console.info(
      '[ccb-log-audit] no fresh actionable warning/error; zero tokens used',
    )
    return
  }
  console.info(
    `[ccb-log-audit] ${events.length} new event(s); starting advisor`,
  )
  const code = await runAdvisor(events)
  if (code !== 0) process.exitCode = code
})
