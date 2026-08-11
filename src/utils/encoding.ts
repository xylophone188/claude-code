/**
 * Encoding helpers for log output.
 *
 * The ccb log file (~/.ccb-embed/ccb-real.log) is the convergence point for
 * diagnostics from many sources: ccb's own routing stage log, hook output,
 * and external subprocesses (e.g. plugin SessionEnd hooks). Some of those
 * sources emit text that is double-encoded UTF-8 - the true UTF-8 bytes were
 * decoded as Latin-1 and then re-encoded as UTF-8, producing mojibake such as
 * "a" instead of the real CJK text.
 *
 * ccb's own capture/write path is clean UTF-8, so the only durable fix that
 * survives external (managed, auto-overwritten) plugins is to sanitize the
 * bytes on the way into the log file. The helpers below do that without
 * mangling legitimate text.
 */

const LATIN_HIGH = /[\u0080-\u00ff]/

/**
 * Format a Date as `yyyy-MM-dd HH:mm:ss.SSS` in the system's local timezone.
 *
 * Intentionally NOT toISOString() (which is always UTC) - the log must read in
 * the operator's local time so timestamps line up with other local log files.
 */
export function formatLocalTimestamp(d: Date = new Date()): string {
  const p = (n: number, len = 2): string => String(n).padStart(len, '0')
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(
      d.getMilliseconds(),
      3,
    )}`
  )
}

/**
 * Repair double-encoded UTF-8 in a string.
 *
 * Double-encoding (UTF-8 bytes read as Latin-1 then re-encoded) produces a
 * string composed entirely of Latin-1 high characters (U+0080-U+00FF).
 * Reinterpreting those code points as bytes and decoding as UTF-8 recovers the
 * original text.
 *
 * The repair is guarded so it never corrupts legitimate text:
 *   - only acts when the input contains Latin-1 high chars (the mojibake
 *     signature),
 *   - only accepts the repair when it removes those high chars (i.e. the text
 *     became proper high-Unicode) and introduced no U+FFFD replacement chars.
 * Normal text such as "cafe" or "-" is passed through untouched.
 */
export function repairUtf8(input: string): string {
  if (!input) return input
  if (!LATIN_HIGH.test(input)) return input
  const repaired = Buffer.from(input, 'latin1').toString('utf8')
  if (repaired === input) return input
  if (repaired.includes('\uFFFD')) return input
  if (LATIN_HIGH.test(repaired)) return input
  return repaired
}
