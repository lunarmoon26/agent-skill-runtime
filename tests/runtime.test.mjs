import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

import { Context, Service } from "@deepseek-ai/cordis"
import { Client } from "@modelcontextprotocol/client"
import { InMemoryTransport } from "@modelcontextprotocol/server"

import {
  assertPortableJsonSchema,
  createSkillRuntime,
  loadSkillManifest,
  SkillExecutionError,
  SkillPolicyError,
  SkillValidationError,
  validateSkillPlugin,
} from "../dist/index.js"
import { registerDeepSeekTools } from "../dist/deepseek.js"
import { createSkillMcpServer } from "../dist/mcp.js"
import { createOpenCodePlugin } from "../dist/opencode.js"

const testDirectory = dirname(fileURLToPath(import.meta.url))
const fixtureRoot = join(testDirectory, "fixtures/plugin")

async function waitForFile(path) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const content = await readFile(path, "utf8")
      if (content.length > 0) return content
    } catch (error) {
      if (error?.code !== "ENOENT") throw error
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for ${path}`)
}

test("discovers manifests and reports fixed entrypoints", async () => {
  const report = await validateSkillPlugin({ pluginRoot: fixtureRoot })
  assert.equal(report.manifestCount, 1)
  assert.equal(report.toolCount, 8)
  assert.equal(report.tools[0].name, "echo_runtime")
  assert.equal(report.tools[0].manifest, "skills/echo/skill-runtime.json")
})

test("executes JSON tools with an allowlisted environment", async () => {
  process.env.RUNTIME_HIDDEN_VALUE = "must-not-leak"
  try {
    const runtime = await createSkillRuntime({
      pluginRoot: fixtureRoot,
      environment: { RUNTIME_TEST_VALUE: "allowed" },
    })
    const result = await runtime.execute("echo_runtime", { message: "hello" }, { cwd: fixtureRoot })
    assert.deepEqual(result, {
      echo: "hello",
      cwd: fixtureRoot,
      explicitEnvironment: "allowed",
      hiddenEnvironment: null,
    })
  } finally {
    delete process.env.RUNTIME_HIDDEN_VALUE
  }
})

for (const operation of ["execute", "prepare"]) {
  test(`${operation} preserves outcomes when diagnostic observers throw or reject`, async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-skill-runtime-observer-"))
    try {
      await writeFile(join(root, "package.json"), '{"type":"module"}\n')
      const script = 'process.stderr.write("operation diagnostic\\n"); process.stdout.write("{}\\n"); process.exitCode = Number(process.env.TEST_EXIT_CODE)\n'
      await writeFile(join(root, "main.mjs"), script)
      // Node stands in for uv: `node sync --quiet --script main.py` runs this fixture.
      await writeFile(join(root, "sync"), script)
      await writeFile(join(root, "main.py"), '# /// script\n# dependencies = []\n# ///\n')
      await writeFile(join(root, "skill-runtime.json"), JSON.stringify({
        manifestVersion: 1,
        name: "observer-runtime",
        tools: [{
          name: "observer_runtime",
          title: "Observer Runtime",
          description: "Emit a diagnostic before succeeding or failing.",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
          entrypoint: operation === "prepare"
            ? { engine: "python-uv", path: "main.py" }
            : { engine: "node", path: "main.mjs" },
        }],
      }))
      for (const rejects of [false, true]) {
        for (const exitCode of [0, 7]) {
          const seen = []
          const runtime = await createSkillRuntime({
            pluginRoot: root,
            commands: { "python-uv": "bun" in process.versions ? "node" : process.execPath },
            environment: { TEST_EXIT_CODE: String(exitCode) },
            onDiagnostic(name, diagnostic) {
              seen.push({ name, diagnostic })
              const error = new Error("observer failed")
              if (rejects) return Promise.reject(error)
              throw error
            },
          })
          const result = operation === "prepare" ? runtime.prepare() : runtime.execute("observer_runtime", {})
          if (exitCode === 0) {
            assert.deepEqual(await result, operation === "prepare" ? undefined : {})
          } else {
            await assert.rejects(result, (error) => error instanceof SkillExecutionError
              && error.code === (operation === "prepare" ? "SKILL_PREPARE_FAILED" : "SKILL_EXECUTION_ERROR")
              && error.message === "operation diagnostic")
          }
          await new Promise((resolve) => setImmediate(resolve))
          assert.deepEqual(seen, [{ name: "observer_runtime", diagnostic: "operation diagnostic" }])
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
}

test("rejects invalid input before execution", async () => {
  const runtime = await createSkillRuntime({ pluginRoot: fixtureRoot })
  await assert.rejects(
    runtime.execute("echo_runtime", { message: 3 }),
    (error) => error instanceof SkillValidationError && error.code === "SKILL_VALIDATION_ERROR",
  )
})

test("requires explicit approval for privileged capabilities", async () => {
  const runtime = await createSkillRuntime({ pluginRoot: fixtureRoot })
  await assert.rejects(
    runtime.execute("privileged_runtime", {}),
    (error) => error instanceof SkillPolicyError && /filesystem-write/.test(error.message),
  )
  const result = await runtime.execute("privileged_runtime", {}, {
    approve: ({ capabilities }) => capabilities.includes("filesystem-write"),
  })
  assert.deepEqual(result, { ok: true })
})

test("forwards cancellation and enforces output byte limits", async () => {
  const runtime = await createSkillRuntime({ pluginRoot: fixtureRoot })
  const controller = new AbortController()
  const started = Date.now()
  setTimeout(() => controller.abort(), 50)
  await assert.rejects(
    runtime.execute("slow_runtime", {}, { signal: controller.signal }),
    (error) => error instanceof SkillExecutionError && error.code === "SKILL_CANCELLED",
  )
  assert.ok(Date.now() - started < 2_000)
  await assert.rejects(
    runtime.execute("large_runtime", {}),
    (error) => error instanceof SkillExecutionError && error.code === "SKILL_OUTPUT_LIMIT",
  )
})

test("cancellation terminates descendant processes", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-skill-runtime-tree-"))
  const marker = join(root, "marker.txt")
  const runtime = await createSkillRuntime({ pluginRoot: fixtureRoot })
  const controller = new AbortController()
  const execution = runtime.execute("tree_runtime", { marker }, {
    approve: () => true,
    signal: controller.signal,
  })
  try {
    assert.equal(await waitForFile(marker), "ready")
    controller.abort()
    await assert.rejects(
      execution,
      (error) => error instanceof SkillExecutionError && error.code === "SKILL_CANCELLED",
    )
    await new Promise((resolve) => setTimeout(resolve, 700))
    assert.equal(await readFile(marker, "utf8"), "ready")
  } finally {
    controller.abort()
    await execution.catch(() => {})
    await rm(root, { recursive: true, force: true })
  }
})

test("requires a trailing newline on stdout", async () => {
  const runtime = await createSkillRuntime({ pluginRoot: fixtureRoot })
  await assert.rejects(
    runtime.execute("newline_runtime", {}),
    (error) => error instanceof SkillExecutionError && error.code === "SKILL_OUTPUT_INVALID",
  )
})

test("rejects invalid UTF-8 on stdout", async () => {
  const runtime = await createSkillRuntime({ pluginRoot: fixtureRoot })
  await assert.rejects(
    runtime.execute("invalid_utf8_runtime", {}),
    (error) => error instanceof SkillExecutionError
      && error.code === "SKILL_OUTPUT_INVALID"
      && /invalid UTF-8/.test(error.message),
  )
})

test("rejects unsupported schemas and escaping entrypoints", async () => {
  assert.throws(
    () => assertPortableJsonSchema({ type: "string", pattern: "x" }),
    SkillValidationError,
  )
  await assert.rejects(
    validateSkillPlugin({ pluginRoot: join(testDirectory, "fixtures/escape") }),
    (error) => error instanceof SkillValidationError && /escapes the skill root/.test(error.message),
  )
})

test("accepts exact PEP 723 dependency pins", async () => {
  const manifest = await loadSkillManifest(join(testDirectory, "fixtures/python-uv/skill-runtime.json"))
  assert.equal(manifest.tools[0].entrypoint.engine, "python-uv")
})

test("python entrypoints run in UTF-8 mode", async (context) => {
  if (spawnSync("python3", ["--version"]).status !== 0) {
    context.skip("python3 is unavailable")
    return
  }
  const root = join(testDirectory, "fixtures/python")
  const runtime = await createSkillRuntime({ pluginRoot: root })
  assert.deepEqual(await runtime.execute("python_runtime", {}), { utf8Mode: 1 })
})

test("parses inline PEP 723 dependencies and rejects non-exact pins", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-skill-runtime-pep-"))
  const manifestPath = join(root, "skill-runtime.json")
  const entrypoint = join(root, "main.py")
  const manifest = {
    manifestVersion: 1,
    name: "pep-runtime",
    tools: [{
      title: "PEP Runtime",
      name: "pep_runtime",
      description: "Validate PEP 723 metadata.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      entrypoint: { engine: "python-uv", path: "main.py" },
    }],
  }
  try {
    await writeFile(manifestPath, JSON.stringify(manifest))
    await writeFile(entrypoint, '# /// script\n# dependencies = ["Pillow==12.3.0"]\n# ///\n')
    await loadSkillManifest(manifestPath)

    await writeFile(entrypoint, '# /// script\n# dependencies = ["Pillow>=12.3.0"]\n# ///\n')
    await assert.rejects(
      loadSkillManifest(manifestPath),
      (error) => error instanceof SkillValidationError && /exact == pins/.test(error.message),
    )

    await writeFile(entrypoint, '# /// script\n# dependencies = "Pillow==12.3.0"\n# ///\n')
    await assert.rejects(
      loadSkillManifest(manifestPath),
      (error) => error instanceof SkillValidationError && /TOML string array/.test(error.message),
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("reports native engine availability without running skill code", async () => {
  const runtime = await createSkillRuntime({ pluginRoot: fixtureRoot })
  const nodeCommand = "bun" in process.versions ? "node" : process.execPath
  assert.deepEqual(await runtime.doctor(), [{
    engine: "node",
    command: nodeCommand,
    available: true,
    version: spawnSync(nodeCommand, ["--version"], { encoding: "utf8" }).stdout.trim(),
  }])
})

test("Wasmtime execution adds no ambient host access flags", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-skill-runtime-wasm-"))
  const skillRoot = join(root, "skills", "wasm")
  try {
    await mkdir(skillRoot, { recursive: true })
    await writeFile(join(root, "package.json"), '{"type":"module"}\n')
    await writeFile(join(root, "run"), 'process.stdout.write(`${JSON.stringify({ argv: process.argv.slice(2) })}\\n`)\n')
    await writeFile(join(skillRoot, "module.wasm"), "not executed")
    await writeFile(join(skillRoot, "skill-runtime.json"), JSON.stringify({
      manifestVersion: 1,
      name: "wasm-runtime",
      tools: [{
        title: "Wasm Runtime",
        name: "wasm_runtime",
        description: "Report the arguments supplied to Wasmtime.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        outputSchema: {
          type: "object",
          properties: { argv: { type: "array", items: { type: "string" } } },
          required: ["argv"],
          additionalProperties: false,
        },
        entrypoint: { engine: "wasmtime", path: "module.wasm", args: ["--fixed"] },
      }],
    }))
    const nodeCommand = "bun" in process.versions ? "node" : process.execPath
    const runtime = await createSkillRuntime({ pluginRoot: root, commands: { wasmtime: nodeCommand } })
    assert.deepEqual(await runtime.execute("wasm_runtime", {}, { cwd: root }), {
      argv: [await realpath(join(skillRoot, "module.wasm")), "--fixed"],
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("OpenCode adapter exposes and executes portable tools", async () => {
  const plugin = createOpenCodePlugin({ pluginRoot: fixtureRoot })
  const hooks = await plugin({})
  const definition = hooks.tool.echo_runtime
  assert.equal(definition.description, "Echo a message and selected process context.")
  const output = await definition.execute({ message: "open" }, {
    directory: fixtureRoot,
    worktree: fixtureRoot,
    abort: new AbortController().signal,
    ask: async () => {},
    metadata: () => {},
    sessionID: "session",
    messageID: "message",
    agent: "test",
  })
  assert.equal(JSON.parse(output).echo, "open")
})

test("DeepSeek adapter registers executable tool definitions", async () => {
  const definitions = []
  await registerDeepSeekTools({
    tools: {
      register(definition) {
        definitions.push(definition)
        return () => {}
      },
    },
  }, { pluginRoot: fixtureRoot, cwd: fixtureRoot })
  const definition = definitions.find((candidate) => candidate.name === "echo_runtime")
  assert.ok(definition)
  const output = await definition.execute({ message: "deepseek" }, { signal: new AbortController().signal })
  assert.equal(output.echo, "deepseek")
  assert.deepEqual(definition.output.render({}, output), [{ type: "text", text: JSON.stringify(output) }])
})

test("DeepSeek registrations follow the owning Cordis fiber lifecycle", async () => {
  class ToolRegistry extends Service {
    definitions = new Map()

    constructor(context) {
      super(context, "tools")
    }

    register(definition) {
      return this.ctx.effect(() => {
        this.definitions.set(definition.name, definition)
        return () => this.definitions.delete(definition.name)
      })
    }
  }

  const context = new Context()
  await context.plugin(ToolRegistry)
  const fiber = await context.plugin(Object.assign(
    (inner) => registerDeepSeekTools(inner, { pluginRoot: fixtureRoot, cwd: fixtureRoot }),
    { inject: ["tools"] },
  ))
  assert.equal(context.tools.definitions.has("echo_runtime"), true)
  await fiber.dispose()
  assert.equal(context.tools.definitions.has("echo_runtime"), false)
  await context.fiber.dispose()
})

test("MCP adapter lists and calls portable tools", async () => {
  const server = await createSkillMcpServer({ pluginRoot: fixtureRoot, cwd: fixtureRoot })
  const client = new Client({ name: "runtime-test", version: "1.0.0" })
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  try {
    const listed = await client.listTools()
    const echo = listed.tools.find((tool) => tool.name === "echo_runtime")
    assert.equal(echo.title, "Echo Runtime")
    assert.equal(echo.annotations.readOnlyHint, true)
    const scalarDefinition = listed.tools.find((tool) => tool.name === "scalar_runtime")
    assert.deepEqual(scalarDefinition.outputSchema, {
      type: "object",
      properties: { result: { type: "string" } },
      required: ["result"],
    })
    const called = await client.callTool({ name: "echo_runtime", arguments: { message: "mcp" } })
    assert.equal(called.isError, undefined)
    assert.equal(JSON.parse(called.content[0].text).echo, "mcp")
    assert.equal(called.structuredContent.echo, "mcp")
    const scalar = await client.callTool({ name: "scalar_runtime", arguments: {} })
    assert.equal(scalar.content[0].text, "scalar")
    assert.deepEqual(scalar.structuredContent, { result: "scalar" })
    const denied = await client.callTool({ name: "privileged_runtime", arguments: {} })
    assert.equal(denied.isError, true)
    assert.match(denied.content[0].text, /SKILL_POLICY_ERROR.*filesystem-write/)
  } finally {
    await client.close()
    await server.close()
  }
})

test("CLI runs a tool using the same contract", () => {
  const result = spawnSync(
    process.execPath,
    [join(testDirectory, "../dist/cli.js"), "run", "echo_runtime", "--root", fixtureRoot, "--cwd", fixtureRoot],
    { input: '{"message":"cli"}\n', encoding: "utf8" },
  )
  assert.equal(result.status, 0, result.stderr)
  assert.equal(JSON.parse(result.stdout).echo, "cli")
})

test("CLI rejects invalid UTF-8 input", () => {
  const result = spawnSync(
    process.execPath,
    [join(testDirectory, "../dist/cli.js"), "run", "echo_runtime", "--root", fixtureRoot],
    { input: Buffer.from([0x7b, 0x22, 0x6d, 0x65, 0x73, 0x73, 0x61, 0x67, 0x65, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d]), encoding: "utf8" },
  )
  assert.equal(result.status, 1)
  assert.match(result.stderr, /SKILL_VALIDATION_ERROR: stdin contains invalid UTF-8/)
})
