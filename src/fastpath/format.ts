// FastPath 格式化 — JSON/YAML/Markdown/Code，零外部依赖。
import type { Json } from './validate'

export function formatJson(input: string | Json, indent = 2): string {
  const data = typeof input === 'string' ? (JSON.parse(input) as Json) : input
  return JSON.stringify(data, null, indent)
}

type YamlValue =
  | string
  | number
  | boolean
  | null
  | YamlValue[]
  | { [k: string]: YamlValue }

function yamlScalar(v: YamlValue): string | null {
  // 可单行输出的标量 / 空集合；复杂结构返回 null 走块风格
  if (v === null) return 'null'
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (typeof v === 'string') {
    if (
      v === '' ||
      /^[\s#:>-]|[:#\n"']/.test(v) ||
      /^(true|false|null|~)$/i.test(v) ||
      /^\d/.test(v)
    ) {
      return JSON.stringify(v)
    }
    return v
  }
  if (Array.isArray(v)) return v.length === 0 ? '[]' : null
  if (Object.keys(v).length === 0) return '{}'
  return null
}

function dumpYaml(value: YamlValue, indent: number): string {
  const pad = ' '.repeat(indent)
  const scalar = yamlScalar(value)
  if (scalar !== null) return `${pad}${scalar}\n`
  if (Array.isArray(value)) {
    let out = ''
    for (const el of value) {
      const child = dumpYaml(el, indent + 2)
      const first = child.slice(indent + 2)
      out += `${pad}- ${first}${child.slice(indent + 2 + first.length)}`
    }
    return out
  }
  let out = ''
  for (const [k, v] of Object.entries(value as Record<string, YamlValue>)) {
    const s = yamlScalar(v)
    if (s !== null) out += `${pad}${k}: ${s}\n`
    else out += `${pad}${k}:\n${dumpYaml(v, indent + 2)}`
  }
  return out
}

export function formatYaml(obj: YamlValue): string {
  const s = yamlScalar(obj)
  if (s !== null) return `${s}\n`
  return dumpYaml(obj, 0)
}

export function formatMarkdown(text: string): string {
  return (
    text
      .split('\n')
      .map(line => line.replace(/[ \t]+$/, ''))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/^(#{1,6})([^ \s#])/gm, '$1 $2')
      .trimStart() + '\n'
  )
}

export async function formatCode(code: string, lang = 'ts'): Promise<string> {
  // ponytail: prettier 为可选依赖（当前未安装）。用运行时 specifier 探测，缺失则原样返回。升级路径：bun add prettier 即生效。
  const spec = 'prettier'
  try {
    const mod = (await import(spec)) as {
      format: (src: string, opts: Record<string, unknown>) => Promise<string>
    }
    return await mod.format(code, { parser: lang === 'py' ? 'python' : lang })
  } catch {
    return code
  }
}
