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
