import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'

export type LogAuditState = {
  version: 1
  files: Record<string, { offset: number }>
  fingerprints: Record<string, number>
}

export type LogAuditEvent = {
  fingerprint: string
  level: 'warn' | 'error'
  source: string
  text: string
}

const HOUR_MS = 60 * 60 * 1000
const DEDUPE_MS = 24 * HOUR_MS
const RETENTION_MS = 14 * 24 * HOUR_MS

export function emptyLogAuditState(): LogAuditState {
  return { version: 1, files: {}, fingerprints: {} }
}

function levelOf(line: string): LogAuditEvent['level'] | undefined {
  const bracketed = line.match(/\[(warn|error)\]/i)?.[1]?.toLowerCase()
  if (bracketed === 'warn' || bracketed === 'error') return bracketed
  if (/\b(?:warn(?:ing)?|api error|failed:|fatal)\b/i.test(line)) {
    return /\b(?:error|api error|failed:|fatal)\b/i.test(line)
      ? 'error'
      : 'warn'
  }
  return undefined
}

function occurredAt(line: string): number | undefined {
  const match = line.match(
    /^(\d{4}-\d{2}-\d{2}(?:T| )\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/,
  )
  if (!match) return undefined
  const parsed = Date.parse(match[1]!.replace(' ', 'T'))
  return Number.isFinite(parsed) ? parsed : undefined
}

/** Keep diagnosis useful without handing credentials or account identifiers to
 * the advisor. */
export function redactLogLine(line: string): string {
  return line
    .replace(/\b(?:Bearer|Basic)\s+\S+/gi, match =>
      match.replace(/\s+\S+$/, ' <redacted>'),
    )
    .replace(/\b(?:sk|nvapi)-[A-Za-z0-9_-]+\b/g, '<redacted>')
    .replace(/((?:[?&]|\b)(?:api[_-]?key|token|key)=)[^&\s]+/gi, '$1<redacted>')
    .replace(
      /(\b(?:chatgpt[_-]?)?account(?:[_-]?id)?|\bemail|\buser[_-]?id)(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,}]+)/gi,
      '$1$2<redacted>',
    )
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, '<id>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1_200)
}

function fingerprint(level: LogAuditEvent['level'], text: string): string {
  const stable = text
    .replace(/^\d{4}-\d{2}-\d{2}(?:T| )[^ ]+\s+/, '')
    .replace(/\b\d+(?:\.\d+)?(?:ms|s)?\b/g, '#')
  return createHash('sha256').update(`${level}\0${stable}`).digest('hex')
}

function prune(state: LogAuditState, now: number): void {
  for (const [key, seenAt] of Object.entries(state.fingerprints)) {
    if (seenAt < now - RETENTION_MS) delete state.fingerprints[key]
  }
}

/** Read only appended lines. A first run is bounded to current hour; later
 * runs use the saved offset, including after log rotation. */
export async function collectLogAuditEvents(
  file: string,
  state: LogAuditState,
  now = Date.now(),
): Promise<LogAuditEvent[]> {
  let metadata
  try {
    metadata = await stat(file)
  } catch {
    return []
  }
  const previous = state.files[file]?.offset ?? 0
  const offset = previous > metadata.size ? 0 : previous
  const content = (await readFile(file)).subarray(offset).toString('utf8')
  state.files[file] = { offset: metadata.size }
  prune(state, now)

  const events: LogAuditEvent[] = []
  const local = new Set<string>()
  for (const line of content.split(/\r?\n/)) {
    const level = levelOf(line)
    const at = occurredAt(line)
    if (!level || (at !== undefined && at < now - HOUR_MS)) continue
    const text = redactLogLine(line)
    if (!text) continue
    const key = fingerprint(level, text)
    if (local.has(key) || (state.fingerprints[key] ?? 0) > now - DEDUPE_MS)
      continue
    local.add(key)
    state.fingerprints[key] = now
    events.push({ fingerprint: key, level, source: file, text })
  }
  return events
}
