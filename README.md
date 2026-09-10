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

Pull requests and pushes to `main` run the full verification suite on Node.js
22.20 and 24, plus the runtime tests on Bun 1.4.

## Releases

npm releases use [trusted publishing](https://docs.npmjs.com/trusted-publishers/)
from GitHub Actions. The release workflow accepts only a `vX.Y.Z` tag that
matches the committed `package.json` version and points to a commit contained
in `main`. It repeats the Node and Bun verification before publishing. npm uses
the workflow's short-lived OIDC identity and adds provenance automatically; no
long-lived npm token is stored in GitHub.

Configure the npm package's GitHub Actions trusted publisher once with these
exact values:

- Organization or user: `lunarmoon26`
- Repository: `agent-skill-runtime`
- Workflow filename: `npm-publish.yml`
- Environment: none
- Allowed action: direct `npm publish`

For each release:

1. Update `package.json` and `package-lock.json` to the same new version in a
   reviewed change, then merge it to `main`.
2. Tag the merged `main` commit and push the tag:

   ```sh
   git tag vX.Y.Z
   git push origin vX.Y.Z
   ```

The tag starts `.github/workflows/npm-publish.yml`. Branch pushes and pull
requests never publish. After the first trusted release succeeds, configure
the npm package to require two-factor authentication and disallow traditional
publish tokens.

Version `0.1.0` was published manually before release automation existed. Do
not create a retrospective `v0.1.0` tag after this workflow reaches `main`; the
first automated release must use a new package version and matching tag.
