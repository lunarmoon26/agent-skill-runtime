/** A value that survives lossless JSON serialization. */
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

/** Scalar values accepted by the portable JSON Schema subset. */
export type JsonScalar = null | boolean | number | string

/** JSON Schema vocabulary shared by MCP, OpenCode, and DeepSeek Harness adapters. */
export interface PortableJsonSchema {
  type?: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null"
  oneOf?: PortableJsonSchema[]
  properties?: Record<string, PortableJsonSchema>
  required?: string[]
  additionalProperties?: boolean
  items?: PortableJsonSchema
  enum?: JsonScalar[]
  const?: JsonScalar
  description?: string
  title?: string
  default?: JsonValue
  examples?: JsonValue
}

/** Execution engines supported by the version 1 runtime. */
export type SkillEngine = "node" | "python" | "python-uv" | "wasmtime"

/** Capabilities declared by an executable tool. */
export type SkillCapability = "filesystem-read" | "filesystem-write" | "network" | "process"

/** Fixed executable selected by the skill author. */
export interface SkillEntrypoint {
  engine: SkillEngine
  path: string
  args?: string[]
}

/** Per-call resource ceilings. */
export interface SkillLimits {
  timeoutMs?: number
  maxInputBytes?: number
  maxOutputBytes?: number
}

/** Standard MCP hints projected without treating them as security controls. */
export interface SkillToolAnnotations {
  readOnlyHint: boolean
  destructiveHint: boolean
  idempotentHint: boolean
  openWorldHint: boolean
}

/** One model-callable executable declared by a skill. */
export interface SkillToolManifest {
  title: string
  name: string
  description: string
  inputSchema: PortableJsonSchema
  outputSchema?: PortableJsonSchema
  entrypoint: SkillEntrypoint
  capabilities?: SkillCapability[]
  annotations?: SkillToolAnnotations
  limits?: SkillLimits
}

/** Contents of a skill-local `skill-runtime.json` file. */
export interface SkillRuntimeManifest {
  $schema?: string
  manifestVersion: 1
  name: string
  tools: SkillToolManifest[]
}

/** A validated tool paired with its resolved owning paths. */
export interface LoadedSkillTool {
  pluginRoot: string
  skillRoot: string
  manifestPath: string
  manifestName: string
  tool: SkillToolManifest
}

/** A request for permission to run privileged skill capabilities. */
export interface SkillApprovalRequest {
  tool: LoadedSkillTool
  capabilities: SkillCapability[]
  input: JsonValue
}

/** Host-provided settings for discovery and execution. */
export interface SkillRuntimeOptions {
  pluginRoot: string
  manifestPaths?: string[]
  approvedCapabilities?: SkillCapability[]
  approve?: (request: SkillApprovalRequest) => boolean | Promise<boolean>
  environment?: Record<string, string>
  commands?: Partial<Record<SkillEngine, string>>
  onDiagnostic?: (toolName: string, diagnostic: string) => void
}

/** Context that varies for each tool invocation. */
export interface SkillInvocationOptions {
  cwd?: string
  signal?: AbortSignal
  approve?: (request: SkillApprovalRequest) => boolean | Promise<boolean>
}

/** Availability information for one engine used by discovered tools. */
export interface SkillEngineStatus {
  engine: SkillEngine
  command: string
  available: boolean
  version?: string
  error?: string
}

/** Validation result returned by programmatic and CLI callers. */
export interface SkillValidationReport {
  pluginRoot: string
  manifestCount: number
  toolCount: number
  tools: Array<{
    name: string
    engine: SkillEngine
    entrypoint: string
    manifest: string
  }>
}
