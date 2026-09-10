import { readdir, realpath, stat } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"

import { SkillValidationError } from "./errors.js"
import { loadSkillManifest } from "./manifest.js"
import type { LoadedSkillTool, SkillRuntimeOptions, SkillValidationReport } from "./types.js"

function isContained(root: string, candidate: string): boolean {
  const path = relative(root, candidate)
  return path === "" || path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path)
}

async function defaultManifestPaths(pluginRoot: string): Promise<string[]> {
  const paths: string[] = []
  const rootManifest = join(pluginRoot, "skill-runtime.json")
  if (await stat(rootManifest).then((value) => value.isFile(), () => false)) paths.push(rootManifest)

  const skillsRoot = join(pluginRoot, "skills")
  const entries = await readdir(skillsRoot, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return []
    throw error
  })
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) continue
    const manifestPath = join(skillsRoot, entry.name, "skill-runtime.json")
    if (await stat(manifestPath).then((value) => value.isFile(), () => false)) paths.push(manifestPath)
  }
  return paths
}

/** Discover and validate every configured skill tool under a plugin root. */
export async function discoverSkillTools(options: Pick<SkillRuntimeOptions, "pluginRoot" | "manifestPaths">): Promise<LoadedSkillTool[]> {
  const pluginRoot = await realpath(resolve(options.pluginRoot)).catch((error) => {
    throw new SkillValidationError(`plugin root does not exist: ${options.pluginRoot}`, { cause: error })
  })
  const requested = options.manifestPaths
    ? options.manifestPaths.map((path) => resolve(pluginRoot, path))
    : await defaultManifestPaths(pluginRoot)
  if (requested.length === 0) throw new SkillValidationError(`no skill-runtime.json files found under ${pluginRoot}`)

  const tools: LoadedSkillTool[] = []
  const names = new Set<string>()
  for (const requestedPath of requested) {
    const manifestPath = await realpath(requestedPath).catch((error) => {
      throw new SkillValidationError(`manifest does not exist: ${requestedPath}`, { cause: error })
    })
    if (!isContained(pluginRoot, manifestPath)) {
      throw new SkillValidationError(`manifest escapes plugin root: ${requestedPath}`)
    }
    if (basename(manifestPath) !== "skill-runtime.json") {
      throw new SkillValidationError(`runtime manifest must be named skill-runtime.json: ${requestedPath}`)
    }
    const manifest = await loadSkillManifest(manifestPath)
    const skillRoot = dirname(manifestPath)
    for (const tool of manifest.tools) {
      if (names.has(tool.name)) throw new SkillValidationError(`duplicate tool name across manifests: ${tool.name}`)
      names.add(tool.name)
      tools.push({ pluginRoot, skillRoot, manifestPath, manifestName: manifest.name, tool })
    }
  }
  return tools
}

/** Validate a plugin root and return a stable summary suitable for CI output. */
export async function validateSkillPlugin(
  options: Pick<SkillRuntimeOptions, "pluginRoot" | "manifestPaths">,
): Promise<SkillValidationReport> {
  const tools = await discoverSkillTools(options)
  const pluginRoot = tools[0]?.pluginRoot ?? resolve(options.pluginRoot)
  return {
    pluginRoot,
    manifestCount: new Set(tools.map((tool) => tool.manifestPath)).size,
    toolCount: tools.length,
    tools: tools.map(({ tool, manifestPath }) => ({
      name: tool.name,
      engine: tool.entrypoint.engine,
      entrypoint: tool.entrypoint.path,
      manifest: relative(pluginRoot, manifestPath),
    })),
  }
}
