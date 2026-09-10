import { tool } from "@opencode-ai/plugin"
import type { Plugin, ToolDefinition } from "@opencode-ai/plugin"

import { createSkillRuntime } from "./runtime.js"
import type { JsonValue, PortableJsonSchema, SkillRuntimeOptions } from "./types.js"

type OpenCodeSchema = InstanceType<typeof tool.schema.ZodType>

function baseSchema(schema: PortableJsonSchema): OpenCodeSchema {
  if (schema.oneOf) {
    const branches = schema.oneOf.map((branch) => portableSchemaToZod(branch))
    return tool.schema.unknown().superRefine((value, context) => {
      const matches = branches.filter((branch) => branch.safeParse(value).success).length
      if (matches !== 1) context.addIssue({ code: "custom", message: "value must match exactly one schema branch" })
    })
  }

  switch (schema.type) {
    case "object": {
      const required = new Set(schema.required ?? [])
      const properties = Object.fromEntries(Object.entries(schema.properties ?? {}).map(([name, child]) => {
        const property = portableSchemaToZod(child)
        return [name, required.has(name) ? property : property.optional()]
      }))
      const object = tool.schema.object(properties)
      return schema.additionalProperties === false ? object.strict() : object.passthrough()
    }
    case "array": return tool.schema.array(schema.items ? portableSchemaToZod(schema.items) : tool.schema.unknown())
    case "string": return tool.schema.string()
    case "number": return tool.schema.number()
    case "integer": return tool.schema.number().int()
    case "boolean": return tool.schema.boolean()
    case "null": return tool.schema.null()
    default: return tool.schema.json()
  }
}

function portableSchemaToZod(schema: PortableJsonSchema): OpenCodeSchema {
  let result = baseSchema(schema)
  if (schema.enum) {
    result = result.refine((value) => schema.enum?.some((candidate) => Object.is(candidate, value)), {
      message: "value is not in enum",
    })
  }
  if (Object.hasOwn(schema, "const")) {
    result = result.refine((value) => Object.is(schema.const, value), { message: "value does not match const" })
  }
  if (schema.description) result = result.describe(schema.description)
  return result
}

function renderResult(result: JsonValue): string {
  return typeof result === "string" ? result : JSON.stringify(result)
}

/** Create an OpenCode plugin that exposes every tool found below one plugin root. */
export function createOpenCodePlugin(options: SkillRuntimeOptions): Plugin {
  return async () => {
    const runtime = await createSkillRuntime(options)
    const definitions: Record<string, ToolDefinition> = {}
    for (const loaded of runtime.listTools()) {
      if (loaded.tool.inputSchema.type !== "object") continue
      const objectSchema = portableSchemaToZod(loaded.tool.inputSchema)
      const shape = objectSchema instanceof tool.schema.ZodObject
        ? objectSchema.shape
        : undefined
      if (!shape) throw new Error(`${loaded.tool.name} input schema could not be converted to an OpenCode object`)
      definitions[loaded.tool.name] = tool({
        description: loaded.tool.description,
        args: shape,
        execute: async (args, context) => {
          const result = await runtime.execute(loaded.tool.name, args as JsonValue, {
            cwd: context.directory,
            signal: context.abort,
            approve: async (request) => {
              await context.ask({
                permission: `skill-runtime:${loaded.tool.name}`,
                patterns: request.capabilities,
                always: request.capabilities,
                metadata: { skill: loaded.manifestName, capabilities: request.capabilities },
              })
              return true
            },
          })
          return renderResult(result)
        },
      })
    }
    return { tool: definitions }
  }
}
