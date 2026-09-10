import type { Context } from "@deepseek-ai/cordis"

import { createSkillRuntime } from "./runtime.js"
import type { JsonValue, PortableJsonSchema, SkillRuntimeOptions } from "./types.js"

interface DeepSeekExecution {
  signal: AbortSignal
}

interface DeepSeekToolDefinition {
  name: string
  description: string
  parameters: PortableJsonSchema
  output: {
    schema: PortableJsonSchema
    render(args: unknown, value: JsonValue): Array<{ type: "text"; text: string }>
  }
  timeoutMs?: number
  execute(args: unknown, execution: DeepSeekExecution): Promise<JsonValue>
}

interface DeepSeekToolRegistry {
  register(definition: DeepSeekToolDefinition): () => void
}

/** DeepSeek-specific options layered over the portable runtime settings. */
export interface DeepSeekRuntimeOptions extends SkillRuntimeOptions {
  cwd?: string
}

/** Register portable skill tools in an initialized DeepSeek Harness tool registry. */
export async function registerDeepSeekTools(context: Context, options: DeepSeekRuntimeOptions): Promise<void> {
  const runtime = await createSkillRuntime(options)
  const registry = (context as Context & { tools: DeepSeekToolRegistry }).tools
  if (!registry || typeof registry.register !== "function") {
    throw new Error("DeepSeek Harness tools service is required")
  }
  for (const loaded of runtime.listTools()) {
    // The DeepSeek registry owns each registration as an effect of this context.
    registry.register({
      name: loaded.tool.name,
      description: loaded.tool.description,
      parameters: loaded.tool.inputSchema,
      output: {
        schema: loaded.tool.outputSchema ?? {},
        render: (_args, value) => [{
          type: "text",
          text: typeof value === "string" ? value : JSON.stringify(value),
        }],
      },
      ...(loaded.tool.limits?.timeoutMs ? { timeoutMs: loaded.tool.limits.timeoutMs } : {}),
      execute: (args, execution) => runtime.execute(loaded.tool.name, args as JsonValue, {
        cwd: options.cwd ?? process.cwd(),
        signal: execution.signal,
      }),
    })
  }
}
