import { routeLog } from '../../routing/stageLog.js'

/**
 * Clash External Controller node rotator.
 *
 * When an OpenCode free upstream returns HTTP 429 (Too Many Requests) or a
 * Cloudflare IP block, we ask the local Clash controller to advance the
 * configured selector group (default: `总模式`) to the next usable proxy.
 * This keeps the free-tier traffic flowing without manual intervention.
 *
 * Configuration via environment:
 * - `CLASH_EXTERNAL_CONTROLLER` — base URL, default `http://127.0.0.1:9090`.
 * - `CLASH_SECRET` — optional bearer secret.
 * - `CLASH_GROUP_NAME` — selector group to rotate, default `总模式`.
 * - `CLASH_ROTATE_COOLDOWN_MS` — per-node cooldown after it trips a 429,
 *   default `60_000`.
 * - `CLASH_ROTATE_DISABLED` — set to `1` to fully disable (fail-open).
 *
 * 429-tripped nodes are also kept in an in-memory daily pool so a public node
 * that exhausts its short cooldown is not selected again until the next UTC
 * day. The short cooldown remains configurable for transient re-use cases.
 *
 * Node names beginning with `DIRECT`, `REJECT`, `🌐`, `⛔️`, `🚫`, or `ALL·`
 * are treated as non-rotatable pseudo-proxies and skipped during rotation.
 */

const DEFAULT_CONTROLLER = 'http://127.0.0.1:9090'
const DEFAULT_GROUP = '总模式'
const DEFAULT_COOLDOWN_MS = 60_000

const NON_ROTATABLE_PREFIXES = [
  'DIRECT',
  'REJECT',
  '🌐',
  '⛔️',
  '🚫',
  'ALL·',
  'GLOBAL',
]

export interface ClashRotationConfig {
  baseURL: string
  secret: string | undefined
  groupName: string
  cooldownMs: number
  disabled: boolean
}

let testConfig: Partial<ClashRotationConfig> | null = null

/** Test-only: override the config resolution. Pass `null` to reset. */
export function __setClashRotationConfigForTest(
  cfg: Partial<ClashRotationConfig> | null,
): void {
  testConfig = cfg
}

export function getClashRotationConfig(): ClashRotationConfig {
  if (testConfig) {
    return {
      baseURL: testConfig.baseURL ?? DEFAULT_CONTROLLER,
      secret: testConfig.secret,
      groupName: testConfig.groupName ?? DEFAULT_GROUP,
      cooldownMs: testConfig.cooldownMs ?? DEFAULT_COOLDOWN_MS,
      disabled: testConfig.disabled ?? false,
    }
  }
  const disabled = process.env.CLASH_ROTATE_DISABLED === '1'
  const cooldownMs =
    Number(process.env.CLASH_ROTATE_COOLDOWN_MS) || DEFAULT_COOLDOWN_MS
  return {
    baseURL: process.env.CLASH_EXTERNAL_CONTROLLER ?? DEFAULT_CONTROLLER,
    secret: process.env.CLASH_SECRET || undefined,
    groupName: process.env.CLASH_GROUP_NAME ?? DEFAULT_GROUP,
    cooldownMs,
    disabled,
  }
}

function isRotatableNode(name: string): boolean {
  if (!name) return false
  for (const prefix of NON_ROTATABLE_PREFIXES) {
    if (name.startsWith(prefix)) return false
  }
  return true
}

const cooledUntil = new Map<string, number>()
const dailyCooled = new Map<string, string>()
let dailyPoolDay = new Date().toISOString().slice(0, 10)

function currentDay(): string {
  return new Date().toISOString().slice(0, 10)
}

function rollDailyPool(): void {
  const day = currentDay()
  if (dailyPoolDay !== day) {
    dailyPoolDay = day
    dailyCooled.clear()
  }
}

/** Mark a node as cooled (skip it during rotation) for `cooldownMs`. */
export function markNodeCooldown(node: string, cooldownMs: number): void {
  rollDailyPool()
  cooledUntil.set(node, Date.now() + cooldownMs)
  dailyCooled.set(node, dailyPoolDay)
}

function isNodeCooled(node: string): boolean {
  rollDailyPool()
  if (dailyCooled.has(node)) return true
  const until = cooledUntil.get(node)
  if (!until) return false
  if (Date.now() >= until) {
    cooledUntil.delete(node)
    return false
  }
  return true
}

/** Test-only: clear all cooldown state. */
export function __clearClashCooldownForTest(): void {
  cooledUntil.clear()
  dailyCooled.clear()
  dailyPoolDay = currentDay()
}

/** True when an HTTP status / error represents a Clash-rotatable 429. */
export function isClashRotatable429(
  status: number | undefined,
  error: unknown,
): boolean {
  if (status === 429) return true
  // Cloudflare IP block: 403 with cf-ray / "Sorry, you are not allowed" body,
  // or 1020 error code. These also warrant a node rotation.
  if (status === 403 || status === 503) {
    const message =
      error instanceof Error
        ? error.message
        : typeof error === 'string'
          ? error
          : ''
    return /cloudflare|cf-ray|1020|sorry.*not allowed|access denied/i.test(
      message,
    )
  }
  return false
}

interface ClashProxyGroup {
  name: string
  now?: string
  all?: string[]
  type?: string
}

function authHeaders(secret: string | undefined): Record<string, string> {
  if (!secret) return {}
  return { Authorization: `Bearer ${secret}` }
}

/** Fetch the selector group's current state from the Clash controller. */
export async function fetchClashGroup(
  cfg: ClashRotationConfig,
): Promise<ClashProxyGroup | null> {
  const url = `${cfg.baseURL}/proxies/${encodeURIComponent(cfg.groupName)}`
  const res = await fetch(url, { headers: authHeaders(cfg.secret) })
  if (!res.ok) return null
  return (await res.json()) as ClashProxyGroup
}

/** Pick the next rotatable node after `current` in `all`, skipping cooled. */
export function pickNextNode(
  all: string[],
  current: string | undefined,
  _cfg: ClashRotationConfig,
): string | null {
  if (all.length === 0) return null
  const rotatable = all.filter(
    name => isRotatableNode(name) && !isNodeCooled(name),
  )
  if (rotatable.length === 0) return null
  if (!current) return rotatable[0] ?? null
  const idx = rotatable.indexOf(current)
  if (idx === -1) return rotatable[0] ?? null
  const next = rotatable[(idx + 1) % rotatable.length]
  return next ?? null
}

/** PUT a node switch on the configured selector group. */
export async function putClashGroupNode(
  cfg: ClashRotationConfig,
  node: string,
): Promise<boolean> {
  const url = `${cfg.baseURL}/proxies/${encodeURIComponent(cfg.groupName)}`
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(cfg.secret),
    },
    body: JSON.stringify({ name: node }),
  })
  return res.ok
}

export interface ClashRotationResult {
  rotated: boolean
  previous: string | undefined
  next: string | undefined
  reason: string
}

/**
 * Advance the configured Clash selector group to the next rotatable node,
 * marking the current node as cooled so it is skipped until the cooldown
 * expires. Failures are logged but never thrown — 429 handling must be
 * fail-open so the upstream retry loop can still proceed.
 */
export async function rotateClashNodeOn429(
  reason: string,
): Promise<ClashRotationResult> {
  const cfg = getClashRotationConfig()
  const noop: ClashRotationResult = {
    rotated: false,
    previous: undefined,
    next: undefined,
    reason,
  }
  if (cfg.disabled) return noop
  try {
    const group = await fetchClashGroup(cfg)
    if (!group || group.type !== 'Selector' || !group.all?.length) {
      routeLog('clash_rotate', 'clash group unavailable or non-selector', {
        group: cfg.groupName,
      })
      return noop
    }
    const previous = group.now
    if (previous) markNodeCooldown(previous, cfg.cooldownMs)
    const next = pickNextNode(group.all, previous, cfg)
    if (!next) {
      routeLog('clash_rotate', 'no rotatable clash node available', {
        group: cfg.groupName,
        previous,
      })
      return { rotated: false, previous, next: undefined, reason }
    }
    const ok = await putClashGroupNode(cfg, next)
    routeLog('clash_rotate', ok ? 'rotated clash node' : 'clash PUT failed', {
      group: cfg.groupName,
      previous,
      next,
      reason,
    })
    return {
      rotated: ok,
      previous,
      next: ok ? next : undefined,
      reason,
    }
  } catch (error) {
    routeLog('clash_rotate', 'clash rotation error', {
      group: cfg.groupName,
      errorType: error instanceof Error ? error.name : typeof error,
    })
    return noop
  }
}
