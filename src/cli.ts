#!/usr/bin/env node

import { parseArgs, TextDecoder } from "node:util"
import { realpathSync } from "node:fs"
import { fileURLToPath } from "node:url"

import { validateSkillPlugin } from "./discovery.js"
import { SkillRuntimeError, SkillValidationError } from "./errors.js"
import { serveSkillMcpStdio } from "./mcp.js"
import { createSkillRuntime } from "./runtime.js"
import type { JsonValue, SkillCapability, SkillRuntimeOptions } from "./types.js"

const capabilities = new Set<SkillCapability>([
  "filesystem-read",
  "filesystem-write",
  "network",
  "process",
])

function usage(): string {
  return `Usage: agent-skill-runtime <command> [options]

Commands:
  validate             Validate manifests and entrypoints
  list                 List discovered tools
  doctor               Check required execution engines
  prepare              Provision exact python-uv dependencies
  run <tool>           Read JSON from stdin and execute one tool
  mcp                  Serve discovered tools over MCP stdio

Options:
  --root <path>        Plugin root (default: current directory)
  --manifest <path>    Explicit manifest path, repeatable
  --allow <capability> Approve a capability, repeatable
  --cwd <path>         Invocation working directory
  --help               Show this help
`
}

async function readJsonInput(): Promise<JsonValue> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.byteLength
    if (bytes > 16 * 1024 * 1024) throw new SkillValidationError("stdin exceeds 16777216 bytes")
    chunks.push(buffer)
  }
  if (bytes === 0) throw new SkillValidationError("stdin must contain one JSON value")
  let input: string
  try {
    input = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))
  } catch (error) {
    throw new SkillValidationError("stdin contains invalid UTF-8", { cause: error })
  }
  try {
    return JSON.parse(input) as JsonValue
  } catch (error) {
    throw new SkillValidationError("stdin contains invalid JSON", { cause: error })
  }
}

function runtimeOptions(values: {
  root?: string
  manifest?: string[]
  allow?: string[]
}): SkillRuntimeOptions {
  const approvedCapabilities = (values.allow ?? []).map((value): SkillCapability => {
    if (!capabilities.has(value as SkillCapability)) throw new SkillValidationError(`unknown capability: ${value}`)
    return value as SkillCapability
  })
  return {
    pluginRoot: values.root ?? process.cwd(),
    ...(values.manifest ? { manifestPaths: values.manifest } : {}),
    approvedCapabilities,
    onDiagnostic: (_tool, diagnostic) => process.stderr.write(`${diagnostic}\n`),
  }
}

/** Run the command-line interface with explicit arguments. */
export async function main(args: string[] = process.argv.slice(2)): Promise<void> {
  const parsed = parseArgs({
    args,
    allowPositionals: true,
    strict: true,
    options: {
      root: { type: "string" },
      manifest: { type: "string", multiple: true },
      allow: { type: "string", multiple: true },
      cwd: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  })
  if (parsed.values.help || parsed.positionals.length === 0) {
    process.stdout.write(usage())
    return
  }

  const [command, argument, ...extra] = parsed.positionals
  if (extra.length > 0) throw new SkillValidationError(`unexpected arguments: ${extra.join(" ")}`)
  const options = runtimeOptions(parsed.values)

  switch (command) {
    case "validate": {
      if (argument) throw new SkillValidationError("validate does not accept a positional argument")
      process.stdout.write(`${JSON.stringify(await validateSkillPlugin(options), null, 2)}\n`)
      return
    }
    case "list": {
      if (argument) throw new SkillValidationError("list does not accept a positional argument")
      const runtime = await createSkillRuntime(options)
      const tools = runtime.listTools().map(({ manifestName, tool }) => ({
        name: tool.name,
        description: tool.description,
        skill: manifestName,
        engine: tool.entrypoint.engine,
        capabilities: tool.capabilities ?? [],
      }))
      process.stdout.write(`${JSON.stringify(tools, null, 2)}\n`)
      return
    }
    case "doctor": {
      if (argument) throw new SkillValidationError("doctor does not accept a positional argument")
      const runtime = await createSkillRuntime(options)
      const statuses = await runtime.doctor()
      process.stdout.write(`${JSON.stringify(statuses, null, 2)}\n`)
      if (statuses.some((status) => !status.available)) process.exitCode = 1
      return
    }
    case "prepare": {
      if (argument) throw new SkillValidationError("prepare does not accept a positional argument")
      const runtime = await createSkillRuntime(options)
      await runtime.prepare()
      process.stdout.write(`${JSON.stringify({ prepared: true, tools: runtime.listTools().length })}\n`)
      return
    }
    case "run": {
      if (!argument) throw new SkillValidationError("run requires a tool name")
      const runtime = await createSkillRuntime(options)
      const output = await runtime.execute(argument, await readJsonInput(), { cwd: parsed.values.cwd })
      process.stdout.write(`${JSON.stringify(output)}\n`)
      return
    }
    case "mcp": {
      if (argument) throw new SkillValidationError("mcp does not accept a positional argument")
      await serveSkillMcpStdio({ ...options, cwd: parsed.values.cwd })
      return
    }
    default:
      throw new SkillValidationError(`unknown command: ${command}`)
  }
}

const invokedPath = process.argv[1]
const isMain = invokedPath !== undefined
  && realpathSync(invokedPath) === realpathSync(fileURLToPath(import.meta.url))

if (isMain) {
  main().catch((error: unknown) => {
    const code = error instanceof SkillRuntimeError ? `${error.code}: ` : ""
    process.stderr.write(`${code}${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
