// FastPath dispatcher — 规则表匹配 fs./match./pattern./render./template./validate./format./rename.
import * as fs from './fs'
import * as pattern from './pattern'
import { render, missingVars } from './template'
import {
  jsonSchemaValidate,
  typeOf,
  assertType,
  assertValid,
  type SchemaNode,
} from './validate'
import { formatJson, formatYaml, formatMarkdown, formatCode } from './format'
import { toKebab, toSnake, toCamel, toPascal, renameBatch } from './rename'

export type FpOutput = { ok: boolean; result?: unknown; error?: string }

export interface FpRule {
  name: string
  run: (args: unknown[]) => FpOutput | Promise<FpOutput>
}

const r = (name: string, fn: (...a: any[]) => any): FpRule => ({
  name,
  run: args => fn(...args),
})

export const RULES: FpRule[] = [
  // fs.*
  r('fs.ls', (p: string) => fs.ls(p)),
  r('fs.mkdir', (p: string) => fs.mkdir(p)),
  r('fs.read', (p: string) => fs.read(p)),
  r('fs.write', (p: string, c: string) => fs.write(p, c)),
  r('fs.copy', (s: string, d: string) => fs.copy(s, d)),
  r('fs.mv', (s: string, d: string) => fs.mv(s, d)),
  r('fs.rm', (p: string) => fs.rm(p)),
  r('fs.find', (root: string, pat: string) => fs.find(root, pat)),
  // match.* / pattern.* — PatternResult 自带 ok，matches/dt 原样透出
  r('match.uuid', (t: string) => pattern.matchUUID(t)),
  r('match.url', (t: string) => pattern.matchURL(t)),
  r('match.version', (t: string) => pattern.matchVersion(t)),
  r('match.hex', (t: string) => pattern.matchHex(t)),
  r('match.email', (t: string) => pattern.matchEmail(t)),
  r('match.date', (t: string) => pattern.matchDate(t)),
  r('pattern.first', (t: string) => pattern.firstMatch(t)),
  // template.* / render.*
  r('template.render', (tpl: string, vars: Record<string, unknown>) => ({
    ok: true,
    result: render(tpl, vars),
  })),
  r('render.template', (tpl: string, vars: Record<string, unknown>) => ({
    ok: true,
    result: render(tpl, vars),
  })),
  r('template.missingVars', (tpl: string, vars: Record<string, unknown>) => ({
    ok: true,
    result: missingVars(tpl, vars),
  })),
  // validate.*
  r('validate.schema', (schema: SchemaNode, value: unknown) => ({
    ok: true,
    ...jsonSchemaValidate(schema, value),
  })),
  r('validate.typeOf', (value: unknown) => ({
    ok: true,
    result: typeOf(value),
  })),
  r('validate.assertType', (value: unknown, t: string) => {
    try {
      assertType(value, t)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  }),
  r('validate.assert', (schema: SchemaNode, value: unknown) => {
    try {
      assertValid(schema, value)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  }),
  // format.*
  r('format.json', (input: string, indent?: number) => ({
    ok: true,
    result: formatJson(input, indent),
  })),
  r('format.yaml', (obj: never) => ({ ok: true, result: formatYaml(obj) })),
  r('format.markdown', (text: string) => ({
    ok: true,
    result: formatMarkdown(text),
  })),
  r('format.code', (code: string, lang?: string) =>
    formatCode(code, lang).then(out => ({ ok: true, result: out })),
  ),
  // rename.*
  r('rename.kebab', (s: string) => ({ ok: true, result: toKebab(s) })),
  r('rename.snake', (s: string) => ({ ok: true, result: toSnake(s) })),
  r('rename.camel', (s: string) => ({ ok: true, result: toCamel(s) })),
  r('rename.pascal', (s: string) => ({ ok: true, result: toPascal(s) })),
  r('rename.batch', (dir: string, items: { from: string; to: string }[]) =>
    renameBatch(dir, items),
  ),
]

const RULE_MAP = new Map(RULES.map(rule => [rule.name, rule]))

export function canHandle(prompt: string): boolean {
  const trimmed = prompt.trim()
  return [...RULE_MAP.keys()].some(
    name => trimmed === name || trimmed.startsWith(name + ' '),
  )
}

export async function run(
  prompt: string,
  args: unknown[] = [],
): Promise<FpOutput> {
  const trimmed = prompt.trim()
  for (const [name, rule] of RULE_MAP) {
    if (trimmed === name || trimmed.startsWith(name + ' ')) {
      try {
        return await rule.run(args)
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        }
      }
    }
  }
  return { ok: false, error: `no fastpath rule for: ${trimmed.slice(0, 60)}` }
}

export { RULE_MAP }
