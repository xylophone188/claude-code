// FastPath 模式匹配 — 纯正则，零依赖。
export type PatternResult = { ok: boolean; matches: string[]; dt: number }

const UUID =
  /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g
const URL = /\bhttps?:\/\/[^\s<>"']+/g
const VERSION = /\bv?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?\b/g
const HEX =
  /\b0x[0-9a-fA-F]+\b|(?:^|(?<=[^0-9A-Za-z]))#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?(?=$|[^0-9A-Za-z])/g
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g
const DATE =
  /\b\d{4}-\d{2}-\d{2}\b|\b\d{4}\/\d{2}\/\d{2}\b|\b\d{2}-\d{2}-\d{4}\b/g

const PATTERNS: Record<string, RegExp> = {
  uuid: UUID,
  url: URL,
  version: VERSION,
  hex: HEX,
  email: EMAIL,
  date: DATE,
}

function runAll(re: RegExp, text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(re)) out.push(m[0])
  return out
}

function match(kind: string, text: string): PatternResult {
  const t0 = performance.now()
  const re = PATTERNS[kind]
  if (!re) return { ok: false, matches: [], dt: performance.now() - t0 }
  const matches = runAll(re, text)
  return { ok: true, matches, dt: performance.now() - t0 }
}

export const matchUUID = (text: string) => match('uuid', text)
export const matchURL = (text: string) => match('url', text)
export const matchVersion = (text: string) => match('version', text)
export const matchHex = (text: string) => match('hex', text)
export const matchEmail = (text: string) => match('email', text)
export const matchDate = (text: string) => match('date', text)

export function firstMatch(text: string): PatternResult {
  const t0 = performance.now()
  for (const kind of Object.keys(PATTERNS)) {
    const r = match(kind, text)
    if (r.matches.length > 0) return r
  }
  return { ok: true, matches: [], dt: performance.now() - t0 }
}

export const patternNames = Object.keys(PATTERNS)
