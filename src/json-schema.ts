import { SkillValidationError } from "./errors.js"
import type { PortableJsonSchema } from "./types.js"

const allowedKeywords = new Set([
  "type",
  "oneOf",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "const",
  "description",
  "title",
  "default",
  "examples",
])

function isScalar(value: unknown): value is null | boolean | number | string {
  return value === null
    || typeof value === "boolean"
    || typeof value === "string"
    || typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0)
}

function scalarMatches(type: PortableJsonSchema["type"], value: unknown): boolean {
  switch (type) {
    case "string": return typeof value === "string"
    case "number": return typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0)
    case "integer": return typeof value === "number" && Number.isSafeInteger(value)
    case "boolean": return typeof value === "boolean"
    case "null": return value === null
    default: return false
  }
}

function visitSchema(schema: PortableJsonSchema, path: string, violations: string[]): void {
  for (const key of Object.keys(schema)) {
    if (!allowedKeywords.has(key)) violations.push(`${path}: unsupported keyword ${key}`)
  }

  const constraintKeys = ["type", "properties", "required", "additionalProperties", "items", "enum", "const"]
    .filter((key) => Object.hasOwn(schema, key))
  if (schema.oneOf !== undefined) {
    if (schema.oneOf.length < 2) violations.push(`${path}.oneOf: expected at least two branches`)
    if (constraintKeys.length > 0) violations.push(`${path}: oneOf cannot be combined with ${constraintKeys.join(", ")}`)
    schema.oneOf.forEach((branch, index) => visitSchema(branch, `${path}.oneOf[${index}]`, violations))
    return
  }

  if (schema.properties !== undefined || schema.required !== undefined || schema.additionalProperties !== undefined) {
    if (schema.type !== "object") violations.push(`${path}: object keywords require type object`)
  }
  if (schema.items !== undefined && schema.type !== "array") {
    violations.push(`${path}: items requires type array`)
  }
  if (schema.enum !== undefined || Object.hasOwn(schema, "const")) {
    if (!schema.type || schema.type === "object" || schema.type === "array") {
      violations.push(`${path}: enum and const require a scalar type`)
    }
  }

  if (schema.properties) {
    for (const [name, child] of Object.entries(schema.properties)) {
      visitSchema(child, `${path}.properties.${name}`, violations)
    }
  }
  if (schema.required) {
    for (const name of schema.required) {
      if (!schema.properties || !Object.hasOwn(schema.properties, name)) {
        violations.push(`${path}.required: ${name} is not declared in properties`)
      }
    }
  }
  if (schema.items) visitSchema(schema.items, `${path}.items`, violations)
  if (schema.enum) {
    const serialized = new Set<string>()
    for (const value of schema.enum) {
      if (!isScalar(value) || !scalarMatches(schema.type, value)) {
        violations.push(`${path}.enum: value does not match type ${schema.type ?? "unknown"}`)
      }
      const key = JSON.stringify(value)
      if (serialized.has(key)) violations.push(`${path}.enum: duplicate value ${key}`)
      serialized.add(key)
    }
  }
  if (Object.hasOwn(schema, "const") && !scalarMatches(schema.type, schema.const)) {
    violations.push(`${path}.const: value does not match type ${schema.type ?? "unknown"}`)
  }
}

/** Assert that a schema uses only the portable, DeepSeek-compatible subset. */
export function assertPortableJsonSchema(
  schema: PortableJsonSchema,
  options: { objectRoot?: boolean; closedObjectRoot?: boolean; label?: string } = {},
): void {
  const path = options.label ?? "schema"
  const violations: string[] = []
  visitSchema(schema, path, violations)
  if (options.objectRoot && schema.type !== "object") {
    violations.push(`${path}: tool input must have type object`)
  }
  if (options.closedObjectRoot && schema.additionalProperties !== false) {
    violations.push(`${path}: tool input must set additionalProperties to false`)
  }
  if (violations.length > 0) throw new SkillValidationError(violations.join("; "))
}
