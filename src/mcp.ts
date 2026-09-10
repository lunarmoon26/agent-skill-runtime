import { fromJsonSchema, McpServer } from "@modelcontextprotocol/server"
import type { JsonSchemaType } from "@modelcontextprotocol/server"
import { serveStdio } from "@modelcontextprotocol/server/stdio"
import type { StdioServerHandle } from "@modelcontextprotocol/server/stdio"

import { SkillRuntimeError } from "./errors.js"
import { createSkillRuntime } from "./runtime.js"
import type { SkillRuntime } from "./runtime.js"
import type { JsonValue, PortableJsonSchema, SkillRuntimeOptions } from "./types.js"

/** MCP-specific settings layered over the portable runtime configuration. */
export interface McpRuntimeOptions extends SkillRuntimeOptions {
  cwd?: string
  serverName?: string
  serverVersion?: string
}

function asMcpSchema(schema: PortableJsonSchema): JsonSchemaType {
  return schema as unknown as JsonSchemaType
}

function textResult(value: JsonValue): string {
  return typeof value === "string" ? value : JSON.stringify(value)
}

function createServer(runtime: SkillRuntime, options: McpRuntimeOptions): McpServer {
  const server = new McpServer({
    name: options.serverName ?? "agent-skill-runtime-mcp-server",
    version: options.serverVersion ?? "0.1.0",
  })
  for (const loaded of runtime.listTools()) {
    const inputSchema = fromJsonSchema(asMcpSchema(loaded.tool.inputSchema))
    const outputSchema = loaded.tool.outputSchema
      ? fromJsonSchema(asMcpSchema(loaded.tool.outputSchema))
      : undefined
    server.registerTool(
      loaded.tool.name,
      {
        title: loaded.tool.title,
        description: loaded.tool.description,
        inputSchema,
        ...(outputSchema ? { outputSchema } : {}),
        ...(loaded.tool.annotations ? { annotations: loaded.tool.annotations } : {}),
      },
      async (args, context) => {
        try {
          const output = await runtime.execute(loaded.tool.name, args as JsonValue, {
            cwd: options.cwd ?? process.cwd(),
            signal: context.mcpReq.signal,
          })
          return {
            content: [{ type: "text", text: textResult(output) }],
            ...(loaded.tool.outputSchema ? { structuredContent: output } : {}),
          }
        } catch (error) {
          if (!(error instanceof SkillRuntimeError)) {
            process.stderr.write(`Unexpected skill runtime error: ${error instanceof Error ? error.message : String(error)}\n`)
          }
          const message = error instanceof SkillRuntimeError
            ? `${error.code}: ${error.message}`
            : "SKILL_EXECUTION_ERROR: Tool execution failed"
          return { isError: true, content: [{ type: "text", text: message }] }
        }
      },
    )
  }
  return server
}

/** Create an MCP server exposing every validated skill tool below a plugin root. */
export async function createSkillMcpServer(options: McpRuntimeOptions): Promise<McpServer> {
  return createServer(await createSkillRuntime(options), options)
}

/** Serve skill tools over MCP stdio until the transport closes. */
export async function serveSkillMcpStdio(options: McpRuntimeOptions): Promise<StdioServerHandle> {
  const runtime = await createSkillRuntime(options)
  return serveStdio(() => createServer(runtime, options), {
    onerror: (error) => process.stderr.write(`${error.message}\n`),
  })
}
