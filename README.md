# Agent Skill Runtime

`@lunarmoon26/agent-skill-runtime` turns skill-owned JSON-in/JSON-out scripts into tools for MCP, OpenCode, and DeepSeek Harness. A versioned `skill-runtime.json` file supplies the portable tool description; thin host adapters preserve each harness's native lifecycle and cancellation behavior.

## Status

This repository contains the version 1 contract and its reference TypeScript implementation. Version `0.1.0` is the initial pre-release.

## Quick Start

Place a manifest beside a skill's `SKILL.md`:

```json
{
  "$schema": "https://raw.githubusercontent.com/lunarmoon26/agent-skill-runtime/main/skill-runtime.schema.json",
  "manifestVersion": 1,
  "name": "example-skill",
  "tools": [
    {
      "title": "Run Example",
      "name": "example_run",
      "description": "Run the example workflow.",
      "inputSchema": {
        "type": "object",
        "properties": {
          "message": { "type": "string" }
        },
        "required": ["message"],
        "additionalProperties": false
      },
      "entrypoint": {
        "engine": "node",
        "path": "scripts/main.mjs"
      }
    }
  ]
}
```

The entrypoint reads one JSON value from stdin, writes one JSON value followed by a newline to stdout, writes diagnostics to stderr, and exits nonzero on failure.

```sh
npx @lunarmoon26/agent-skill-runtime validate --root .
npx @lunarmoon26/agent-skill-runtime list --root .
printf '{"message":"hello"}' | npx @lunarmoon26/agent-skill-runtime run example_run --root .
npx @lunarmoon26/agent-skill-runtime mcp --root .
```

`python-uv` entrypoints declare exact PEP 723 dependencies in their script. Run `prepare` before invoking them; normal tool execution uses `uv --offline` and never downloads packages.

## Package Exports

- `@lunarmoon26/agent-skill-runtime`: discovery, validation, preparation, and execution.
- `@lunarmoon26/agent-skill-runtime/opencode`: OpenCode tool adapter.
- `@lunarmoon26/agent-skill-runtime/deepseek`: DeepSeek Harness tool adapter.
- `@lunarmoon26/agent-skill-runtime/mcp`: MCP stdio server.

See [`docs/contract.md`](docs/contract.md) for the execution and security rules and [`docs/integrations.md`](docs/integrations.md) for host examples.

## Development

```sh
npm install
npm test
npm run verify
```
