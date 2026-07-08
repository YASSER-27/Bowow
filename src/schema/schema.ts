/**
 * Lightweight schema/validation system for Bowow data types.
 *
 * Provides runtime validation, type inference, serialization,
 * and branded types — similar to Effect Schema but without the dependency.
 */

// ── Branded Types ──

export type Brand<T, B extends string> = T & { __brand: B }

export function brand<T, B extends string>(value: T, _brand: B): Brand<T, B> {
  return value as Brand<T, B>
}

export type AbsolutePath = Brand<string, 'AbsolutePath'>
export type RelativePath = Brand<string, 'RelativePath'>
export type SessionID = Brand<string, 'SessionID'>
export type MessageID = Brand<string, 'MessageID'>
export type BuildID = Brand<number, 'BuildID'>
export type NonNegativeInt = Brand<number, 'NonNegativeInt'>
export type PositiveInt = Brand<number, 'PositiveInt'>
export type Timestamp = Brand<number, 'Timestamp'>

// ── Schema Definition ──

export type SchemaType =
  | 'string' | 'number' | 'boolean' | 'integer'
  | 'array' | 'object' | 'null'
  | 'enum' | 'union' | 'and'

export interface SchemaDef<T = any> {
  type: SchemaType
  optional?: boolean
  nullable?: boolean
  default?: T
  items?: SchemaDef
  properties?: Record<string, SchemaDef>
  required?: string[]
  enum?: T[]
  schemas?: SchemaDef[]
  validate?: (value: unknown) => value is T
  coerce?: (value: unknown) => T
  description?: string
  brand?: string
  min?: number
  max?: number
  pattern?: RegExp
}

// ── Schema Builder ──

export const S = {
  string(def?: Partial<SchemaDef<string>>): SchemaDef<string> {
    return { type: 'string', ...def }
  },

  number(def?: Partial<SchemaDef<number>>): SchemaDef<number> {
    return { type: 'number', ...def }
  },

  integer(def?: Partial<SchemaDef<number>>): SchemaDef<number> {
    return { type: 'integer', ...def }
  },

  boolean(def?: Partial<SchemaDef<boolean>>): SchemaDef<boolean> {
    return { type: 'boolean', ...def }
  },

  null(): SchemaDef<null> {
    return { type: 'null' }
  },

  array<T>(items: SchemaDef<T>, def?: Partial<SchemaDef<T[]>>): SchemaDef<T[]> {
    return { type: 'array', items, ...def }
  },

  object<T extends Record<string, SchemaDef>>(
    properties: T,
    def?: { required?: (keyof T)[]; description?: string }
  ): SchemaDef<{ [K in keyof T]: T[K]['default'] extends infer D
    ? D extends undefined ? (T[K]['optional'] extends true ? (T[K]['type'] extends 'null' ? null : undefined) | SchemaTypeOf<T[K]> : SchemaTypeOf<T[K]>)
    : SchemaTypeOf<T[K]>
  }> {
    const req = def?.required as string[] | undefined
    return {
      type: 'object',
      properties: properties as Record<string, SchemaDef>,
      required: req || Object.keys(properties),
      ...def,
    } as any
  },

  enum<T extends string>(values: T[]): SchemaDef<T> {
    return { type: 'enum', enum: values } as SchemaDef<T>
  },

  union<T extends SchemaDef[]>(...schemas: T): SchemaDef<SchemaTypeOf<T[number]>> {
    return { type: 'union', schemas } as any
  },

  and<T extends SchemaDef[]>(...schemas: T): SchemaDef<SchemaTypeOf<T[number]>> {
    return { type: 'and', schemas } as any
  },

  optional<T>(schema: SchemaDef<T>): SchemaDef<T | undefined> {
    return { ...schema, optional: true }
  },

  nullable<T>(schema: SchemaDef<T>): SchemaDef<T | null> {
    return { ...schema, nullable: true }
  },

  branded<T, B extends string>(schema: SchemaDef<T>, brand: B): SchemaDef<Brand<T, B>> {
    return { ...schema, brand } as any
  },
}

type SchemaTypeOf<T extends SchemaDef> =
  T['type'] extends 'string' ? string :
  T['type'] extends 'number' | 'integer' ? number :
  T['type'] extends 'boolean' ? boolean :
  T['type'] extends 'null' ? null :
  T['type'] extends 'enum' ? T['enum'] extends ReadonlyArray<infer E> ? E : never :
  T['type'] extends 'array' ? T['items'] extends SchemaDef<infer I> ? I[] : unknown[] :
  T['type'] extends 'object' ? T['properties'] extends Record<string, SchemaDef> ? {
    [K in keyof T['properties']]: SchemaTypeOf<T['properties'][K]>
  } : Record<string, unknown> :
  T['type'] extends 'union' ? T['schemas'] extends ReadonlyArray<SchemaDef<infer U>> ? U : never :
  unknown

// ── Validation ──

export type ValidationIssue = {
  path: string
  message: string
  expected: string
  received: string
}

export class ValidationError extends Error {
  issues: ValidationIssue[]
  constructor(issues: ValidationIssue[]) {
    super(issues.map(i => `${i.path}: ${i.message}`).join('\n'))
    this.issues = issues
  }
}

export function validate<T>(schema: SchemaDef<T>, value: unknown, path = '$'): value is T {
  const issues = validateWithIssues(schema, value, path)
  if (issues.length > 0) throw new ValidationError(issues)
  return true
}

export function validateWithIssues(schema: SchemaDef, value: unknown, path = '$'): ValidationIssue[] {
  const issues: ValidationIssue[] = []

  if (value === null || value === undefined) {
    if (schema.nullable && value === null) return []
    if (schema.optional) return []
    issues.push({ path, message: `Expected ${schema.type}, received ${value}`, expected: schema.type, received: String(value) })
    return issues
  }

  switch (schema.type) {
    case 'string':
      if (typeof value !== 'string')
        issues.push({ path, message: 'Expected string', expected: 'string', received: typeof value })
      else if (schema.pattern && !schema.pattern.test(value))
        issues.push({ path, message: `String does not match pattern ${schema.pattern}`, expected: 'pattern match', received: value })
      break

    case 'number':
    case 'integer':
      if (typeof value !== 'number' || (schema.type === 'integer' && !Number.isInteger(value)))
        issues.push({ path, message: `Expected ${schema.type}`, expected: schema.type, received: typeof value })
      else {
        if (schema.min !== undefined && value < schema.min)
          issues.push({ path, message: `Value ${value} is less than minimum ${schema.min}`, expected: `>= ${schema.min}`, received: String(value) })
        if (schema.max !== undefined && value > schema.max)
          issues.push({ path, message: `Value ${value} exceeds maximum ${schema.max}`, expected: `<= ${schema.max}`, received: String(value) })
      }
      break

    case 'boolean':
      if (typeof value !== 'boolean')
        issues.push({ path, message: 'Expected boolean', expected: 'boolean', received: typeof value })
      break

    case 'array':
      if (!Array.isArray(value)) {
        issues.push({ path, message: 'Expected array', expected: 'array', received: typeof value })
      } else if (schema.items) {
        for (let i = 0; i < value.length; i++)
          issues.push(...validateWithIssues(schema.items, value[i], `${path}[${i}]`))
      }
      break

    case 'object':
      if (typeof value !== 'object' || Array.isArray(value)) {
        issues.push({ path, message: 'Expected object', expected: 'object', received: typeof value })
      } else {
        const obj = value as Record<string, unknown>
        const required = (schema.required || Object.keys(schema.properties || {})) as string[]
        for (const key of required) {
          if (!(key in obj) || obj[key] === undefined)
            issues.push({ path: `${path}.${key}`, message: 'Required field missing', expected: 'present', received: 'undefined' })
        }
        if (schema.properties) {
          for (const [key, propSchema] of Object.entries(schema.properties)) {
            if (key in obj)
              issues.push(...validateWithIssues(propSchema, obj[key], `${path}.${key}`))
          }
        }
      }
      break

    case 'enum':
      if (!schema.enum?.includes(value as any))
        issues.push({ path, message: `Value not in enum [${schema.enum?.join(', ')}]`, expected: `one of [${schema.enum?.join(', ')}]`, received: String(value) })
      break

    case 'union':
      if (schema.schemas) {
        let match = false
        for (const s of schema.schemas) {
          const subIssues = validateWithIssues(s, value, path)
          if (subIssues.length === 0) { match = true; break }
        }
        if (!match)
          issues.push({ path, message: 'Value does not match any union member', expected: 'union match', received: typeof value })
      }
      break
  }

  if (schema.validate && !schema.validate(value))
    issues.push({ path, message: 'Custom validation failed', expected: 'valid', received: String(value) })

  return issues
}

// ── Coercion ──

export function coerce<T>(schema: SchemaDef<T>, value: unknown): T {
  if (schema.coerce) return schema.coerce(value)

  if (value === null || value === undefined) {
    if (schema.default !== undefined) return schema.default as T
    if (schema.optional) return undefined as T
    if (schema.nullable) return null as T
  }

  switch (schema.type) {
    case 'string': return String(value ?? '') as T
    case 'number': return Number(value) as T
    case 'integer': return Math.round(Number(value)) as T
    case 'boolean': return value === 'true' || value === true || value === 1 as T
    case 'array': {
      if (Array.isArray(value)) return value.map(v => schema.items ? coerce(schema.items, v) : v) as T
      if (typeof value === 'string') return value.split(',').map(v => schema.items ? coerce(schema.items, v.trim()) : v.trim()) as T
      return [] as T
    }
    case 'object': {
      if (typeof value === 'object' && !Array.isArray(value)) {
        const result: Record<string, unknown> = {}
        for (const [key, propSchema] of Object.entries(schema.properties || {})) {
          result[key] = (value as any)?.[key] !== undefined
            ? coerce(propSchema, (value as any)[key])
            : propSchema.default
        }
        return result as T
      }
      return {} as T
    }
    default: return value as T
  }
}

// ── Common Schemas ──

export const Schemas = {
  AbsolutePath: S.branded(S.string({ description: 'Absolute file path' }), 'AbsolutePath'),
  RelativePath: S.branded(S.string({ description: 'Relative file path' }), 'RelativePath'),
  SessionID: S.branded(S.string({ description: 'Unique session identifier' }), 'SessionID'),
  MessageID: S.branded(S.string({ description: 'Unique message identifier' }), 'MessageID'),
  PositiveInt: S.integer({ min: 1, description: 'Positive integer' }),
  NonNegativeInt: S.integer({ min: 0, description: 'Non-negative integer' }),
  Timestamp: S.integer({ min: 0, description: 'Unix timestamp in milliseconds' }),

  File: S.object({
    path: Schemas.RelativePath,
    content: S.optional(S.string()),
    contentLoaded: S.optional(S.boolean()),
    size: S.optional(S.number()),
  }, { required: ['path'] }),

  ToolCall: S.object({
    name: S.string(),
    arguments: S.optional(S.object({} as any)),
    id: S.string(),
  }, { required: ['name', 'id'] }),

  TimelineItem: S.object({
    id: S.string(),
    type: S.enum(['file', 'message', 'system']),
    role: S.optional(S.enum(['user', 'assistant', 'system'])),
    content: S.optional(S.string()),
    path: S.optional(S.string()),
    action: S.optional(S.enum(['create', 'edit', 'read', 'run', 'delete'])),
    status: S.optional(S.enum(['pending', 'success', 'error'])),
    toolName: S.optional(S.string()),
    timestamp: S.optional(Schemas.Timestamp),
  }, { required: ['id', 'type'] }),

  ProviderConfig: S.object({
    kind: S.enum(['openai', 'anthropic', 'google', 'azure', 'copilot', 'custom']),
    label: S.string(),
    apiKey: S.string(),
    baseUrl: S.optional(S.string()),
    models: S.array(S.string()),
    defaultModel: S.string(),
  }, { required: ['kind', 'label', 'apiKey', 'models', 'defaultModel'] }),
}

// ── Serialization ──

export function serialize(value: unknown, pretty = false): string {
  return JSON.stringify(value, (_key, val) => {
    if (typeof val === 'bigint') return val.toString()
    return val
  }, pretty ? 2 : undefined)
}

export function deserialize<T = any>(json: string): T {
  return JSON.parse(json)
}

export function clone<T>(value: T): T {
  return deserialize(serialize(value))
}
