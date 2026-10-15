// FastPath 校验 — JSON Schema 子集 + 类型判断，零依赖。
export type Json =
  | string
  | number
  | boolean
  | null
  | Json[]
  | { [k: string]: Json }

export interface SchemaNode {
  type?: string | string[]
  properties?: Record<string, SchemaNode>
  required?: string[]
  items?: SchemaNode
  enum?: Json[]
  minimum?: number
  maximum?: number
  minLength?: number
  maxLength?: number
  pattern?: string
}

export type ValidationResult = { valid: boolean; errors: string[] }

export function typeOf(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  const t = typeof value
  if (t === 'number') return Number.isInteger(value) ? 'integer' : 'number'
  return t
}

function checkType(value: unknown, expected: string): boolean {
  const actual = typeOf(value)
  if (expected === 'number') return actual === 'number' || actual === 'integer'
  return actual === expected
}

export function jsonSchemaValidate(
  schema: SchemaNode,
  value: unknown,
): ValidationResult {
  const errors: string[] = []

  const visit = (node: SchemaNode, v: unknown, path: string): void => {
    if (node.type !== undefined) {
      const types = Array.isArray(node.type) ? node.type : [node.type]
      if (!types.some(t => checkType(v, t))) {
        errors.push(`${path}: expected ${types.join('|')}, got ${typeOf(v)}`)
        return
      }
    }
    if (node.enum !== undefined && !node.enum.includes(v as Json)) {
      errors.push(`${path}: not in enum [${node.enum.join(', ')}]`)
    }
    if (typeof v === 'number') {
      if (node.minimum !== undefined && v < node.minimum)
        errors.push(`${path}: ${v} < minimum ${node.minimum}`)
      if (node.maximum !== undefined && v > node.maximum)
        errors.push(`${path}: ${v} > maximum ${node.maximum}`)
    }
    if (typeof v === 'string') {
      if (node.minLength !== undefined && v.length < node.minLength)
        errors.push(`${path}: length ${v.length} < minLength ${node.minLength}`)
      if (node.maxLength !== undefined && v.length > node.maxLength)
        errors.push(`${path}: length ${v.length} > maxLength ${node.maxLength}`)
      if (node.pattern !== undefined && !new RegExp(node.pattern).test(v))
        errors.push(`${path}: does not match /${node.pattern}/`)
    }
    if (typeOf(v) === 'object') {
      const obj = v as Record<string, unknown>
      for (const req of node.required ?? []) {
        if (!(req in obj))
          errors.push(`${path}.${req}: required property missing`)
      }
      for (const [key, child] of Object.entries(node.properties ?? {})) {
        if (key in obj) visit(child, obj[key], `${path}.${key}`)
      }
    }
    if (Array.isArray(v) && node.items) {
      v.forEach((el, i) => visit(node.items!, el, `${path}[${i}]`))
    }
  }

  visit(schema, value, '$')
  return { valid: errors.length === 0, errors }
}

export function assertType(value: unknown, expected: string): void {
  if (!checkType(value, expected)) {
    throw new TypeError(`expected ${expected}, got ${typeOf(value)}`)
  }
}

export function assertValid(schema: SchemaNode, value: unknown): void {
  const r = jsonSchemaValidate(schema, value)
  if (!r.valid) throw new Error(`schema invalid: ${r.errors.join('; ')}`)
}
