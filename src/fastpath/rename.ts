// FastPath 命名转换 — kebab/snake/camel/pascal + 批量重命名，零依赖。
import { promises as fsp } from 'fs'
import { basename, extname, join, dirname } from 'path'

function words(input: string): string[] {
  return input
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[\s_\-./]+/)
    .filter(w => w.length > 0)
}

const lower = (w: string) => w.toLowerCase()
const cap = (w: string) => lower(w).charAt(0).toUpperCase() + lower(w).slice(1)

export function toKebab(input: string): string {
  return words(input).map(lower).join('-')
}

export function toSnake(input: string): string {
  return words(input).map(lower).join('_')
}

export function toCamel(input: string): string {
  const ws = words(input)
  return ws.map((w, i) => (i === 0 ? lower(w) : cap(w))).join('')
}

export function toPascal(input: string): string {
  return words(input).map(cap).join('')
}

export type RenameItem = { from: string; to: string }
export type RenameResult = {
  ok: boolean
  renamed: RenameItem[]
  errors: string[]
}

export async function renameBatch(
  dir: string,
  items: RenameItem[],
): Promise<RenameResult> {
  const renamed: RenameItem[] = []
  const errors: string[] = []
  for (const it of items) {
    try {
      await fsp.rename(join(dir, it.from), join(dir, it.to))
      renamed.push(it)
    } catch (err) {
      errors.push(
        `${it.from} -> ${it.to}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }
  return { ok: errors.length === 0, renamed, errors }
}

export function renameWith(
  path: string,
  converter: (name: string) => string,
): string {
  const file = basename(path)
  const ext = extname(file)
  return join(
    dirname(path),
    converter(file.slice(0, -ext.length || undefined)) + ext,
  )
}
