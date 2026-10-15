/**
 * PostgreSQL-backed store for Session Memory.
 *
 * PostgreSQL is the authoritative source of truth for session memory
 * segments, in contrast to the on-disk markdown file (a local scratchpad)
 * and Elasticsearch (a search mirror). The write is an UPSERT keyed by
 * session id so concurrent extractions from the same session converge to
 * the latest content.
 *
 * Table:
 *   omniroute.session_memory (
 *     session_id     text PRIMARY KEY,
 *     content        text NOT NULL,
 *     memory_path    text,
 *     bytes          bigint NOT NULL,
 *     updated_at     timestamptz NOT NULL DEFAULT now()
 *   )
 *
 * Invariants:
 *   - NEVER throws — every public function swallows errors and logs.
 *   - NEVER blocks — callers invoke the fire-and-forget `upsert...` helper.
 *   - Opt-out: `CCB_SESSION_MEMORY_PG_ENABLED=0`.
 *   - Idempotent — repeated writes with the same content are a no-op at
 *     the row level (still refreshes `updated_at`, matching "touch"
 *     semantics expected by consumers).
 */
import { readFile, stat } from 'fs/promises'
import { getSessionId } from '../../bootstrap/state.js'
import { getSessionMemoryPath } from '../../utils/permissions/filesystem.js'
import { logError } from '../../utils/log.js'
import { errorMessage } from '../../utils/errors.js'
import { pgExecute, pgIsAvailable, pgQuery } from '../pg/pool.js'

const CREATE_TABLE_SQL = `CREATE TABLE IF NOT EXISTS omniroute.session_memory (
  session_id text PRIMARY KEY,
  content    text NOT NULL,
  memory_path text,
  bytes      bigint NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
)`

const UPSERT_SQL = `INSERT INTO omniroute.session_memory (session_id, content, memory_path, bytes, updated_at)
VALUES ($1, $2, $3, $4, now())
ON CONFLICT (session_id) DO UPDATE SET
  content = EXCLUDED.content,
  memory_path = EXCLUDED.memory_path,
  bytes = EXCLUDED.bytes,
  updated_at = EXCLUDED.updated_at`

let ensureTablePromise: Promise<boolean> | undefined

function isPgEnabled(): boolean {
  return process.env.CCB_SESSION_MEMORY_PG_ENABLED !== '0'
}

async function ensureSessionMemoryTable(): Promise<boolean> {
  if (!ensureTablePromise) {
    ensureTablePromise = pgIsAvailable()
      .then(async ok => {
        if (!ok) return false
        await pgExecute(CREATE_TABLE_SQL)
        return true
      })
      .catch(error => {
        logError(
          new Error('session_memory table create: ' + errorMessage(error)),
        )
        return false
      })
  }
  return ensureTablePromise
}

/**
 * Read session memory from disk and UPSERT into PG. Fire-and-forget —
 * returns a promise the caller may or may not await. Never rejects.
 */
export function upsertSessionMemoryToPg(
  options: { content?: string; memoryPath?: string } = {},
): Promise<void> {
  return upsertSessionMemoryToPgImpl(options).catch(error => {
    logError(new Error('session_memory pg upsert: ' + errorMessage(error)))
  })
}

async function upsertSessionMemoryToPgImpl(
  options: { content?: string; memoryPath?: string } = {},
): Promise<void> {
  if (!isPgEnabled()) return

  const sessionId = getSessionId()
  if (!sessionId) {
    logError(new Error('session_memory pg: no active session id'))
    return
  }

  const memoryPath = options.memoryPath ?? getSessionMemoryPath()
  const content =
    options.content ?? (await readFile(memoryPath, { encoding: 'utf-8' }))
  if (!content || content.length === 0) return

  const bytes = (await stat(memoryPath)).size
  if (!(await ensureSessionMemoryTable())) return

  await pgExecute(UPSERT_SQL, [sessionId, content, memoryPath, bytes])
}

/**
 * Read the current session's memory content back from PG. Returns null on
 * miss or when PG is unavailable. Never throws.
 */
export async function getSessionMemoryFromPg(
  sessionId: string,
): Promise<string | null> {
  if (!isPgEnabled()) return null
  try {
    if (!(await pgIsAvailable())) return null
    const rows = await pgQuery<{ content: string }>(
      'SELECT content FROM omniroute.session_memory WHERE session_id = $1',
      [sessionId],
    )
    return rows[0]?.content ?? null
  } catch (error) {
    logError(new Error('session_memory pg read: ' + errorMessage(error)))
    return null
  }
}

/**
 * Test-only: reset the memoized ensure-table promise.
 */
export function _resetSessionMemoryStoreForTests(): void {
  ensureTablePromise = undefined
}
