import { readFile, realpath } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, isAbsolute, relative, resolve, sep } from "node:path"

import { Ajv2020 } from "ajv/dist/2020.js"
import type { ErrorObject, ValidateFunction } from "ajv"
import { parse } from "smol-toml"

import { SkillValidationError } from "./errors.js"
import { assertPortableJsonSchema } from "./json-schema.js"
import type { SkillRuntimeManifest } from "./types.js"

const require = createRequire(import.meta.url)
const manifestSchema = require("../skill-runtime.schema.json") as object
const ajv = new Ajv2020({ allErrors: true, allowUnionTypes: true, strict: true })
const validateManifest = ajv.compile(manifestSchema) as ValidateFunction<SkillRuntimeManifest>

function formatErrors(errors: ErrorObject[] | null | undefined): string {
  return (errors ?? []).map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`).join("; ")
}

function isContained(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return path === "" || path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}

/** Resolve an existing path while ensuring symlinks cannot escape the owning skill. */
export async function resolveContainedPath(root: string, path: string, label: string): Promise<string> {
  if (isAbsolute(path)) throw new SkillValidationError(`${label} must be relative to the skill root`)
  const canonicalRoot = await realpath(root)
  let canonicalPath: string
  try {
    canonicalPath = await realpath(resolve(canonicalRoot, path))
  } catch (error) {
    throw new SkillValidationError(`${label} does not exist: ${path}`, { cause: error })
  }
  if (!isContained(canonicalRoot, canonicalPath)) {
    throw new SkillValidationError(`${label} escapes the skill root: ${path}`)
  }
  return canonicalPath
}

function expectedExtension(engine: SkillRuntimeManifest["tools"][number]["entrypoint"]["engine"]): string[] {
  switch (engine) {
    case "node": return [".js", ".mjs", ".cjs"]
    case "python":
    case "python-uv": return [".py"]
    case "wasmtime": return [".wasm"]
  }
}

async function assertPinnedPep723(entrypoint: string): Promise<void> {
  const source = await readFile(entrypoint, "utf8")
  const block = source.match(/^# \/\/\/ script\n([\s\S]*?)^# \/\/\/\s*$/m)?.[1]
  if (!block) throw new SkillValidationError(`python-uv entrypoint must contain a PEP 723 script block: ${entrypoint}`)
  let metadata: Record<string, unknown>
  try {
    const toml = block.replace(/\r?\n$/, "").split(/\r?\n/).map((line) => {
      const comment = line.match(/^# ?(.*)$/)
      if (!comment) throw new Error("metadata lines must be comments")
      return comment[1] ?? ""
    }).join("\n")
    metadata = parse(toml)
  } catch (error) {
    throw new SkillValidationError(`python-uv entrypoint has invalid PEP 723 metadata: ${entrypoint}`, { cause: error })
  }
  const dependencies = metadata.dependencies
  if (!Array.isArray(dependencies) || dependencies.some((dependency) => typeof dependency !== "string")) {
    throw new SkillValidationError(`python-uv dependencies must be a TOML string array: ${entrypoint}`)
  }
  if (dependencies.some((dependency) => !/^[A-Za-z0-9_.-]+==[^=\s]+$/.test(dependency))) {
    throw new SkillValidationError(`python-uv dependencies must use exact == pins: ${entrypoint}`)
  }
}

/** Parse and fully validate one skill-local runtime manifest. */
export async function loadSkillManifest(manifestPath: string): Promise<SkillRuntimeManifest> {
  let value: unknown
  try {
    value = JSON.parse(await readFile(manifestPath, "utf8"))
  } catch (error) {
    throw new SkillValidationError(`could not parse ${manifestPath}`, { cause: error })
  }
  if (!validateManifest(value)) {
    throw new SkillValidationError(`${manifestPath}: ${formatErrors(validateManifest.errors)}`)
  }

  const skillRoot = dirname(manifestPath)
  const names = new Set<string>()
  for (const tool of value.tools) {
    if (names.has(tool.name)) throw new SkillValidationError(`${manifestPath}: duplicate tool name ${tool.name}`)
    names.add(tool.name)
    assertPortableJsonSchema(tool.inputSchema, {
      objectRoot: true,
      closedObjectRoot: true,
      label: `${tool.name}.inputSchema`,
    })
    if (tool.outputSchema) assertPortableJsonSchema(tool.outputSchema, { label: `${tool.name}.outputSchema` })
    if (tool.entrypoint.path.includes("\0")) {
      throw new SkillValidationError(`${tool.name}.entrypoint.path contains a null byte`)
    }
    const entrypoint = await resolveContainedPath(skillRoot, tool.entrypoint.path, `${tool.name}.entrypoint.path`)
    if (!expectedExtension(tool.entrypoint.engine).some((extension) => entrypoint.endsWith(extension))) {
      throw new SkillValidationError(`${tool.name}.entrypoint.path does not match engine ${tool.entrypoint.engine}`)
    }
    if (tool.entrypoint.engine === "python-uv") await assertPinnedPep723(entrypoint)
    if (tool.entrypoint.engine === "wasmtime" && (tool.capabilities ?? []).some((capability) => capability !== "filesystem-read")) {
      throw new SkillValidationError(`${tool.name}: wasmtime entrypoints cannot request write, network, or process capabilities`)
    }
  }
  return value
}
