/**
 * Detection of "fake 200" upstream responses: the network layer answers HTTP
 * 200 with a normal-looking completion, but the content is actually a custom
 * error string from the gateway (content moderation, quota, etc.). These must
 * be treated as failures — not surfaced as a model reply — so auto-routing can
 * fall back to another provider and explicit routes surface a real error.
 *
 * Pure string logic: no imports, safe to use from both the OpenAI request path
 * and the shared error classifier without circular dependencies.
 */

const UPSTREAM_CUSTOM_ERROR_PATTERNS: RegExp[] = [
  // Content-moderation gateways (common Chinese provider wording)
  /抱歉，系统检测到您当前输入的信息存在敏感内容/,
  /(?:抱歉|对不起)，?系统检测到.{0,50}(?:敏感|违规|异常)内容/,
  /系统检测到.{0,30}(?:敏感|违规)内容.{0,40}(?:无法|拒绝)响应/,
  // Generic "cannot answer, please retry" refusal wording
  /无法响应(?:您|你)的请求.{0,20}(?:请.{0,10}(?:检查|重新输入|重试|稍后再试))/,
  // Quota, Balance & Rate limit fake 200 errors
  /(?:^|\b)(?:配额不足|余额不足|额度耗尽|账户余额不足|账户欠费|insufficient_quota|quota_exceeded|rate_limit_exceeded|TPM limit exceeded|RPM limit exceeded)(?:\b|[。！,.!])/i,
  // Gateway JSON error objects masquerading as text completions
  /^s*{s*"(?:error|errcode|error_code|status|code)"s*:s*(?:{|"[^"]+"|d+)/,
  // Gateway HTML error pages served with HTTP 200
  /^s*<!DOCTYPEs+html/i,
  /^s*<html[s>]/i,
  // Upstream bad gateway / timeout plain text errors
  /^s*(?:502 Bad Gateway|503 Service Temporarily Unavailable|504 Gateway Time-out)/i,
]

/** Thrown when a 200 response body matches an upstream custom-error pattern. */
export class UpstreamBlockedError extends Error {
  readonly code = 'upstream_blocked' as const

  constructor(blockedText: string) {
    super(`upstream returned a custom error (HTTP 200): ${blockedText}`)
    this.name = 'UpstreamBlockedError'
  }
}

/**
 * Return the offending text when `text` looks like an upstream custom error,
 * or undefined when it is a normal completion. Kept exported so the error
 * classifier and tests can reuse the same pattern set.
 */
export function matchUpstreamCustomError(
  text: string | undefined | null,
): string | undefined {
  if (!text) return undefined
  for (const pattern of UPSTREAM_CUSTOM_ERROR_PATTERNS) {
    if (pattern.test(text)) return text
  }
  return undefined
}
