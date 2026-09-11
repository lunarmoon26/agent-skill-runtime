# Host Integrations

## OpenCode

Export the adapter from an OpenCode plugin package:

```ts
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { createOpenCodePlugin } from "@lunarmoon26/agent-skill-runtime/opencode"

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "..")
export default createOpenCodePlugin({ pluginRoot })
```

The adapter maps the portable schema to Zod, forwards OpenCode's project directory and abort signal, and uses `context.ask` for privileged capabilities.

## DeepSeek Harness

Register tools from a Cordis function plugin:

```ts
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { Context } from "@deepseek-ai/cordis"
import { registerDeepSeekTools } from "@lunarmoon26/agent-skill-runtime/deepseek"

export const name = "example-runtime"
export const inject = ["tools"]

const pluginRoot = join(dirname(fileURLToPath(import.meta.url)), "..")

export async function apply(ctx: Context): Promise<void> {
  await registerDeepSeekTools(ctx, { pluginRoot })
}
```

Add privileged capabilities to `approvedCapabilities` only when the surrounding Harness profile supplies its normal tool-approval policy.

## MCP

An Agent Plugins `mcp.json` can start the stdio server from its plugin root:

```json
{
  "mcpServers": {
    "skill-runtime": {
      "command": "npx",
      "args": [
        "-y",
        "@lunarmoon26/agent-skill-runtime@0.1.1",
        "mcp",
        "--root",
        "${PLUGIN_ROOT}"
      ]
    }
  }
}
```

Add `--allow filesystem-write` only when the plugin's tools need to create or modify files. The MCP host remains responsible for approving each model tool call according to its own policy.
