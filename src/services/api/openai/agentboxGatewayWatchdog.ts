import { existsSync, unlinkSync } from 'fs'
import { execSync } from 'child_process'
import { APIConnectionError } from 'openai'
import { APIUserAbortError } from '@anthropic-ai/sdk/error'
import { logForDebugging } from '../../../utils/debug.js'
import { sleep } from '../../../utils/sleep.js'

export const AGENTBOX_GATEWAY_PORT = 18800
export const AGENTBOX_GATEWAY_HOST = '127.0.0.1'
export const AGENTBOX_GATEWAY_URL = `http://${AGENTBOX_GATEWAY_HOST}:${AGENTBOX_GATEWAY_PORT}`
export const AGENTBOX_GATEWAY_HEALTH_URL = `${AGENTBOX_GATEWAY_URL}/health`

export const TERMUX_SERVICE_DOWN_FILE =
  '/data/data/com.termux/files/usr/var/service/agentbox-gateway/down'
export const TERMUX_SERVICE_DIR =
  '/data/data/com.termux/files/usr/var/service/agentbox-gateway'
export const TERMUX_GATEWAY_BIN =
  '/data/data/com.termux/files/home/bin/agentbox-gateway'

export function getServiceDownFile(): string {
  if (process.env.PREFIX) {
    return `${process.env.PREFIX}/var/service/agentbox-gateway/down`
  }
  return TERMUX_SERVICE_DOWN_FILE
}

export function isLocalGateway18800Target(targetUrl?: string): boolean {
  const candidate =
    targetUrl ||
    process.env.OPENAI_BASE_URL ||
    process.env.OPENCODE_ZEN_BASE_URL ||
    process.env.OPENCODE_FREE_BASE_URL ||
    ''
  return (
    candidate.includes('18800') ||
    candidate.includes('127.0.0.1:18800') ||
    candidate.includes('localhost:18800')
  )
}

export function isLocalGateway18800Error(
  error: unknown,
  targetUrl?: string,
): boolean {
  if (!error) return false

  const isTarget18800 = isLocalGateway18800Target(targetUrl)
  const errStr =
    (error instanceof Error ? error.message : String(error)) +
    ' ' +
    String((error as any)?.cause?.message || (error as any)?.cause || '')

  if (!isTarget18800 && !errStr.includes('18800')) {
    return false
  }

  if (error instanceof APIConnectionError) return true

  const code =
    (error as any)?.code ||
    (error as any)?.cause?.code ||
    (error as any)?.errno
  if (
    code === 'ECONNREFUSED' ||
    code === 'ETIMEDOUT' ||
    code === 'ENOTFOUND' ||
    code === 'ECONNRESET'
  ) {
    return true
  }

  const lower = errStr.toLowerCase()
  return (
    lower.includes('econnrefused') ||
    lower.includes('connection refused') ||
    lower.includes('connection error') ||
    lower.includes('fetch failed') ||
    lower.includes('connect etimedout') ||
    lower.includes('socket hang up')
  )
}

export function isAgentboxGatewayDownFilePresent(): boolean {
  try {
    return existsSync(getServiceDownFile())
  } catch {
    return false
  }
}

export async function checkAgentboxGatewayHealth(
  timeoutMs = 1000,
): Promise<boolean> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const res = await fetch(AGENTBOX_GATEWAY_HEALTH_URL, {
      signal: controller.signal,
    })
    clearTimeout(timer)
    return res.status === 200
  } catch {
    return false
  }
}

export interface HealAgentboxGatewayOptions {
  healthTimeoutMs?: number
  pollIntervalMs?: number
  signal?: AbortSignal
  onLog?: (msg: string) => void
  runner?: (action: string) => Promise<void> | void
  healthChecker?: () => Promise<boolean>
}

export async function healAgentboxGateway(
  options: HealAgentboxGatewayOptions = {},
): Promise<boolean> {
  const {
    healthTimeoutMs = 5000,
    pollIntervalMs = 500,
    signal,
    onLog = logForDebugging,
    runner,
    healthChecker = checkAgentboxGatewayHealth,
  } = options

  if (signal?.aborted) return false

  const downFile = getServiceDownFile()

  // 1. Check and remove stale down lock first
  if (existsSync(downFile)) {
    try {
      unlinkSync(downFile)
      onLog(`[watchdog] Removed stale down lock: ${downFile}`)
    } catch (e) {
      onLog(`[watchdog] Failed to remove down lock: ${String(e)}`)
    }
  }

  // Fast path: if already healthy and no down lock, return immediately
  if (await healthChecker()) {
    return true
  }

  // 2. Execute start/up command
  onLog('[watchdog] Triggering agentbox-gateway service up/start...')
  if (runner) {
    try {
      await runner('start')
    } catch (err) {
      onLog(`[watchdog] Custom start runner error: ${String(err)}`)
    }
  } else {
    try {
      let started = false
      if (existsSync(TERMUX_GATEWAY_BIN)) {
        execSync(`bash "${TERMUX_GATEWAY_BIN}" start`, {
          stdio: 'ignore',
          timeout: 4000,
        })
        started = true
      }
      if (!started && existsSync(TERMUX_SERVICE_DIR)) {
        execSync('sv up agentbox-gateway', {
          stdio: 'ignore',
          timeout: 4000,
        })
      }
    } catch (err) {
      onLog(`[watchdog] Start command error (continuing to poll): ${String(err)}`)
    }
  }

  // 3. Poll health endpoint until healthy or timeout
  const deadline = Date.now() + healthTimeoutMs
  while (Date.now() < deadline) {
    if (signal?.aborted) return false

    if (await healthChecker()) {
      onLog('[watchdog] agentbox-gateway self-healed and HEALTHY on 127.0.0.1:18800')
      return true
    }

    try {
      await sleep(pollIntervalMs, signal, {
        abortError: () => new APIUserAbortError(),
      })
    } catch {
      return false
    }
  }

  onLog(`[watchdog] agentbox-gateway failed to become healthy within ${healthTimeoutMs}ms`)
  return false
}
