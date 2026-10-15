// FastPath 模板渲染 — {{var}} 替换 + {%if var%}...{%endif%} 条件块，零依赖。
export type TemplateVars = Record<string, unknown>

function lookup(vars: TemplateVars, dotted: string): unknown {
  let cur: unknown = vars
  for (const part of dotted.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur
}

function isTruthy(v: unknown): boolean {
  return !(v === undefined || v === null || v === false || v === '' || v === 0)
}

export function render(template: string, vars: TemplateVars): string {
  // 条件块（非贪婪、跨行）
  let out = template.replace(
    /\{%if\s+([\w.]+)%\}([\s\S]*?)\{%endif%\}/g,
    (_m, name: string, body: string) =>
      isTruthy(lookup(vars, name)) ? body : '',
  )
  // 变量替换
  out = out.replace(/\{\{([\w.]+)\}\}/g, (_m, name: string) => {
    const v = lookup(vars, name)
    return v === undefined ? '' : String(v)
  })
  return out
}

export function missingVars(template: string, vars: TemplateVars): string[] {
  const names = new Set<string>()
  for (const m of template.matchAll(/\{\{([\w.]+)\}\}/g)) names.add(m[1])
  for (const m of template.matchAll(/\{%if\s+([\w.]+)%\}/g)) names.add(m[1])
  return [...names].filter(n => lookup(vars, n) === undefined)
}
