import { spawn } from "node:child_process"
import { realpath } from "node:fs/promises"
import { resolve } from "node:path"
import { TextDecoder } from "node:util"

import { Ajv2020 } from "ajv/dist/2020.js"
import type { ValidateFunction } from "ajv"

import { discoverSkillTools } from "./discovery.js"
import { SkillExecutionError, SkillPolicyError, SkillValidationError } from "./errors.js"
import { resolveContainedPath } from "./manifest.js"
import type {
  JsonValue,
  LoadedSkillTool,
  SkillCapability,
  SkillEngine,
  SkillEngineStatus,
  SkillInvocationOptions,
  SkillRuntimeOptions,
} from "./types.js"

const DEFAULT_TIMEOUT_MS = 60_000
const DEFAULT_MAX_INPUT_BYTES = 1024 * 1024
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024
const MAX_STDERR_BYTES = 64 * 1024
const PRIVILEGED_CAPABILITIES = new Set<SkillCapability>(["filesystem-write", "network", "process"])
const PASSTHROUGH_ENVIRONMENT = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "TMPDIR",
  "TMP",
  "TEMP",
  "SystemRoot",
  "WINDIR",
  "LOCALAPPDATA",
  "APPDATA",
  "XDG_CACHE_HOME",
  "UV_CACHE_DIR",
  "UV_PYTHON_INSTALL_DIR",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "LANG",
  "LC_ALL",
] as const

interface PreparedTool {
  loaded: LoadedSkillTool
  entrypoint: string
  validateInput: ValidateFunction
  validateOutput?: ValidateFunction
}

interface ProcessResult {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: Buffer
  stderr: Buffer
}

function formatAjvErrors(validate: ValidateFunction): string {
  return (validate.errors ?? [])
    .map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`)
    .join("; ")
}

function assertJsonValue(value: unknown, path: string): asserts value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return
  if (typeof value === "number") {
    if (Number.isFinite(value) && !Object.is(value, -0)) return
    throw new SkillValidationError(`${path} contains a non-JSON number`)
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonValue(item, `${path}[${index}]`))
    return
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new SkillValidationError(`${path} must contain only plain JSON objects`)
    }
    for (const [key, item] of Object.entries(value)) assertJsonValue(item, `${path}.${key}`)
    return
  }
  throw new SkillValidationError(`${path} is not lossless JSON`)
}

function commandFor(engine: SkillEngine, options: SkillRuntimeOptions): string {
  const configured = options.commands?.[engine]
  if (configured) return configured
  switch (engine) {
    case "node": return "bun" in process.versions ? "node" : process.execPath
    case "python": return "python3"
    case "python-uv": return "uv"
    case "wasmtime": return "wasmtime"
  }
}

function commandArguments(engine: SkillEngine, entrypoint: string, fixedArgs: string[]): string[] {
  switch (engine) {
    case "node": return [entrypoint, ...fixedArgs]
    case "python": return ["-I", "-u", "-X", "utf8", entrypoint, ...fixedArgs]
    case "python-uv": return ["run", "--offline", "--quiet", "--script", entrypoint, ...fixedArgs]
    case "wasmtime": return ["run", entrypoint, ...fixedArgs]
  }
}

function childEnvironment(options: SkillRuntimeOptions): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    PYTHONIOENCODING: "utf-8",
    PYTHONUNBUFFERED: "1",
    UV_NO_PROGRESS: "1",
  }
  for (const key of PASSTHROUGH_ENVIRONMENT) {
    if (process.env[key] !== undefined) environment[key] = process.env[key]
  }
  for (const [key, value] of Object.entries(options.environment ?? {})) environment[key] = value
  return environment
}

function terminateProcess(child: ReturnType<typeof spawn>): Promise<void> {
  const pid = child.pid
  if (!pid && (child.exitCode !== null || child.signalCode !== null)) return Promise.resolve()
  if (process.platform === "win32" && pid) {
    return new Promise((resolveTermination) => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        clearTimeout(fallback)
        resolveTermination()
      }
      const killDirect = (): void => {
        try {
          child.kill("SIGKILL")
        } catch {
          // The process exited while taskkill was running.
        }
      }
      const command = process.env.SystemRoot
        ? resolve(process.env.SystemRoot, "System32", "taskkill.exe")
        : "taskkill"
      const killer = spawn(command, ["/pid", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      })
      killer.once("error", () => {
        killDirect()
        finish()
      })
      killer.once("close", (code) => {
        if (code !== 0) killDirect()
        finish()
      })
      const fallback = setTimeout(() => {
        killer.kill("SIGKILL")
        killDirect()
        finish()
      }, 1_000)
    })
  }
  try {
    if (pid) process.kill(-pid, "SIGTERM")
    else child.kill("SIGTERM")
  } catch {
    // The process may have exited between the state check and signal delivery.
  }
  return new Promise((resolveTermination) => {
    setTimeout(() => {
      try {
        if (pid) process.kill(-pid, "SIGKILL")
        else child.kill("SIGKILL")
      } catch {
        // The process group exited during the grace period.
      }
      resolveTermination()
    }, 250)
  })
}

async function runProcess(options: {
  command: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
  input: Buffer
  timeoutMs: number
  maxOutputBytes: number
  signal?: AbortSignal
}): Promise<ProcessResult> {
  if (options.signal?.aborted) throw new SkillExecutionError("skill execution was cancelled", "SKILL_CANCELLED")

  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    env: options.env,
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  })
  const stdout: Buffer[] = []
  const stderr: Buffer[] = []
  let stdoutBytes = 0
  let stderrBytes = 0
  let terminalError: SkillExecutionError | undefined
  let termination: Promise<void> | undefined

  const stop = (error: SkillExecutionError): void => {
    if (terminalError) return
    terminalError = error
    termination = terminateProcess(child)
  }
  const timeout = setTimeout(() => {
    stop(new SkillExecutionError(`skill execution exceeded ${options.timeoutMs}ms`, "SKILL_TIMEOUT"))
  }, options.timeoutMs)
  timeout.unref()
  const abort = (): void => stop(new SkillExecutionError("skill execution was cancelled", "SKILL_CANCELLED"))
  options.signal?.addEventListener("abort", abort, { once: true })

  child.stdout.on("data", (chunk: Buffer) => {
    stdoutBytes += chunk.byteLength
    if (stdoutBytes > options.maxOutputBytes) {
      stop(new SkillExecutionError(`skill output exceeded ${options.maxOutputBytes} bytes`, "SKILL_OUTPUT_LIMIT"))
      return
    }
    stdout.push(chunk)
  })
  child.stderr.on("data", (chunk: Buffer) => {
    if (stderrBytes >= MAX_STDERR_BYTES) return
    const kept = chunk.subarray(0, MAX_STDERR_BYTES - stderrBytes)
    stderr.push(kept)
    stderrBytes += kept.byteLength
  })
  child.stdin.on("error", () => {
    // A process that exits before consuming stdin is diagnosed from its exit status.
  })

  const settled = await new Promise<ProcessResult>((resolveResult) => {
    let spawnError: Error | undefined
    child.once("error", (error) => {
      spawnError = error
    })
    child.once("close", (code, signal) => {
      if (spawnError && !terminalError) {
        terminalError = new SkillExecutionError(
          `could not start ${options.command}: ${spawnError.message}`,
          "SKILL_ENGINE_UNAVAILABLE",
          { cause: spawnError },
        )
      }
      resolveResult({ code, signal, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) })
    })
    child.stdin.end(options.input)
  })

  clearTimeout(timeout)
  options.signal?.removeEventListener("abort", abort)
  if (terminalError) {
    await termination
    throw terminalError
  }
  return settled
}

/** Validated executor shared by host adapters and the CLI. */
export class SkillRuntime {
  readonly #options: SkillRuntimeOptions
  readonly #tools: Map<string, PreparedTool>

  private constructor(options: SkillRuntimeOptions, tools: PreparedTool[]) {
    this.#options = options
    this.#tools = new Map(tools.map((tool) => [tool.loaded.tool.name, tool]))
  }

  /** Discover manifests and compile every input and output validator. */
  static async create(options: SkillRuntimeOptions): Promise<SkillRuntime> {
    const loaded = await discoverSkillTools(options)
    const ajv = new Ajv2020({ allErrors: true, strict: false })
    const tools = await Promise.all(loaded.map(async (item): Promise<PreparedTool> => ({
      loaded: item,
      entrypoint: await resolveContainedPath(item.skillRoot, item.tool.entrypoint.path, `${item.tool.name}.entrypoint.path`),
      validateInput: ajv.compile(item.tool.inputSchema),
      validateOutput: item.tool.outputSchema ? ajv.compile(item.tool.outputSchema) : undefined,
    })))
    return new SkillRuntime(options, tools)
  }

  /** Return detached descriptors for all discovered tools. */
  listTools(): LoadedSkillTool[] {
    return [...this.#tools.values()].map(({ loaded }) => structuredClone(loaded))
  }

  /** Check the executables required by discovered tools without running skill code. */
  async doctor(): Promise<SkillEngineStatus[]> {
    const engines = [...new Set([...this.#tools.values()].map(({ loaded }) => loaded.tool.entrypoint.engine))]
    return Promise.all(engines.map(async (engine): Promise<SkillEngineStatus> => {
      const command = commandFor(engine, this.#options)
      try {
        const result = await runProcess({
          command,
          args: ["--version"],
          cwd: this.listTools()[0]?.pluginRoot ?? process.cwd(),
          env: childEnvironment(this.#options),
          input: Buffer.alloc(0),
          timeoutMs: 5_000,
          maxOutputBytes: 16_384,
        })
        const version = Buffer.concat([result.stdout, result.stderr]).toString("utf8").trim()
        if (result.code !== 0) return { engine, command, available: false, error: version || `exit code ${result.code}` }
        return { engine, command, available: true, version }
      } catch (error) {
        return { engine, command, available: false, error: error instanceof Error ? error.message : String(error) }
      }
    }))
  }

  private notifyDiagnostic(name: string, diagnostic: string): void {
    if (!diagnostic) return
    try {
      void Promise.resolve(this.#options.onDiagnostic?.(name, diagnostic)).catch(() => {})
    } catch {
      // Observers cannot replace execution/preparation outcomes or recursively report failures.
    }
  }

  /** Provision exact PEP 723 dependencies without executing skill entrypoints. */
  async prepare(signal?: AbortSignal): Promise<void> {
    const preparedEntrypoints = new Set<string>()
    for (const prepared of this.#tools.values()) {
      if (prepared.loaded.tool.entrypoint.engine !== "python-uv" || preparedEntrypoints.has(prepared.entrypoint)) continue
      preparedEntrypoints.add(prepared.entrypoint)
      const command = commandFor("python-uv", this.#options)
      const result = await runProcess({
        command,
        args: ["sync", "--quiet", "--script", prepared.entrypoint],
        cwd: prepared.loaded.skillRoot,
        env: childEnvironment(this.#options),
        input: Buffer.alloc(0),
        timeoutMs: 600_000,
        maxOutputBytes: 64 * 1024,
        signal,
      })
      const diagnostic = result.stderr.toString("utf8").trim()
      this.notifyDiagnostic(prepared.loaded.tool.name, diagnostic)
      if (result.code !== 0) {
        throw new SkillExecutionError(diagnostic || `uv sync exited with code ${result.code}`, "SKILL_PREPARE_FAILED")
      }
    }
  }

  /** Validate one input, apply capability policy, and execute its fixed entrypoint. */
  async execute(name: string, input: JsonValue, invocation: SkillInvocationOptions = {}): Promise<JsonValue> {
    const prepared = this.#tools.get(name)
    if (!prepared) throw new SkillValidationError(`unknown skill tool: ${name}`)
    assertJsonValue(input, `${name} input`)
    if (!prepared.validateInput(input)) {
      throw new SkillValidationError(`${name} input: ${formatAjvErrors(prepared.validateInput)}`)
    }

    const capabilities = prepared.loaded.tool.capabilities ?? []
    const approved = new Set(this.#options.approvedCapabilities ?? [])
    const required = capabilities.filter((capability) => PRIVILEGED_CAPABILITIES.has(capability) && !approved.has(capability))
    if (required.length > 0) {
      const allowed = await (invocation.approve ?? this.#options.approve)?.({
        tool: prepared.loaded,
        capabilities: required,
        input,
      })
      if (allowed !== true) throw new SkillPolicyError(`${name} requires approval for: ${required.join(", ")}`)
    }

    const serialized = Buffer.from(`${JSON.stringify(input)}\n`, "utf8")
    const limits = prepared.loaded.tool.limits ?? {}
    const maxInputBytes = limits.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES
    if (serialized.byteLength > maxInputBytes) {
      throw new SkillValidationError(`${name} input exceeds ${maxInputBytes} bytes`)
    }
    const cwd = await realpath(resolve(invocation.cwd ?? prepared.loaded.pluginRoot)).catch((error) => {
      throw new SkillValidationError(`working directory does not exist: ${invocation.cwd ?? prepared.loaded.pluginRoot}`, { cause: error })
    })
    const engine = prepared.loaded.tool.entrypoint.engine
    const result = await runProcess({
      command: commandFor(engine, this.#options),
      args: commandArguments(engine, prepared.entrypoint, prepared.loaded.tool.entrypoint.args ?? []),
      cwd,
      env: childEnvironment(this.#options),
      input: serialized,
      timeoutMs: limits.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxOutputBytes: limits.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      signal: invocation.signal,
    })
    const diagnostic = result.stderr.toString("utf8").trim()
    this.notifyDiagnostic(name, diagnostic)
    if (result.code !== 0) {
      const suffix = result.signal ? `signal ${result.signal}` : `exit code ${result.code}`
      throw new SkillExecutionError(diagnostic || `${name} failed with ${suffix}`)
    }
    if (result.stdout.length === 0 || result.stdout.at(-1) !== 0x0a) {
      throw new SkillExecutionError(`${name} must write one JSON value followed by a newline`, "SKILL_OUTPUT_INVALID")
    }
    let outputText: string
    try {
      outputText = new TextDecoder("utf-8", { fatal: true }).decode(result.stdout)
    } catch (error) {
      throw new SkillExecutionError(`${name} wrote invalid UTF-8`, "SKILL_OUTPUT_INVALID", { cause: error })
    }
    let output: unknown
    try {
      output = JSON.parse(outputText)
    } catch (error) {
      throw new SkillExecutionError(`${name} wrote invalid JSON`, "SKILL_OUTPUT_INVALID", { cause: error })
    }
    try {
      assertJsonValue(output, `${name} output`)
    } catch (error) {
      throw new SkillExecutionError(
        error instanceof Error ? error.message : `${name} output is not lossless JSON`,
        "SKILL_OUTPUT_INVALID",
        { cause: error },
      )
    }
    if (prepared.validateOutput && !prepared.validateOutput(output)) {
      throw new SkillExecutionError(`${name} output: ${formatAjvErrors(prepared.validateOutput)}`, "SKILL_OUTPUT_INVALID")
    }
    return output
  }
}

/** Create a validated runtime for one plugin root. */
export function createSkillRuntime(options: SkillRuntimeOptions): Promise<SkillRuntime> {
  return SkillRuntime.create(options)
}
