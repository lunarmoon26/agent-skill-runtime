# Version 1 Contract

## Discovery

The runtime accepts an explicit plugin root. By default it reads `skill-runtime.json` at that root and one level below `skills/`. A caller may instead provide explicit manifest paths, but every manifest and resolved entrypoint must remain inside the canonical plugin and skill roots after resolving symlinks.

Tool names are unique across a plugin. Each tool carries a human-readable title and may project all four standard MCP behavior annotations. The version 1 schema deliberately uses the JSON Schema subset enforced by DeepSeek Harness so that all adapters expose equivalent argument validation.

## Process Protocol

Each invocation starts the author-selected entrypoint and sends exactly one JSON object followed by a newline on stdin. The program must:

1. Read the JSON value from stdin.
2. Complete all owned work before returning.
3. Write one lossless UTF-8 JSON value followed by a newline to stdout.
4. Write human-readable diagnostics only to stderr.
5. Exit nonzero when it cannot produce a valid result.

The runtime validates input before starting the process and validates output after strict UTF-8 decoding and JSON parsing. It enforces byte ceilings, a timeout, and caller cancellation. On POSIX, timeout and cancellation terminate the process group even if its leader exits during cleanup. On Windows, the runtime invokes `taskkill /T /F`; version 1 does not provide Job Object containment after the root PID exits, so entrypoints must finish their owned descendants before returning as required above.

## Engines

- `node` executes a `.js`, `.mjs`, or `.cjs` file with Node. A Bun-based host still launches `node` rather than interpreting the entrypoint with Bun.
- `python` executes a `.py` file using isolated, unbuffered `python3` in UTF-8 mode.
- `python-uv` requires a PEP 723 block and exact `==` dependency pins. `prepare` runs `uv sync --script`; invocation runs `uv run --offline --script`.
- `wasmtime` executes a `.wasm` module through the external Wasmtime CLI without preopened directories or network access.

The runtime never downloads an engine. `doctor` reports missing commands, and provisioning occurs only through the explicit `prepare` operation.

Pyodide is not a version 1 execution engine. Browser-only Python can be considered separately for pure-Python skills; it cannot satisfy the native package and subprocess behavior promised by the `python` engines.

## Capabilities

Manifests declare `filesystem-read`, `filesystem-write`, `network`, or `process`. Write, network, and subprocess access require an approval callback or an adapter-level allowlist. OpenCode asks through its native permission UI; CLI and MCP callers use explicit `--allow` flags; DeepSeek deployments opt in through plugin configuration and retain the harness's normal tool policy pipeline.

Capability declarations are policy metadata, not an operating-system sandbox for native Node or Python. Native scripts run with the current user's filesystem authority after approval. Wasmtime receives no preopened directories and cannot declare write, network, or subprocess capabilities in version 1.

## Environment

Child processes receive only runtime essentials such as `PATH`, home/cache locations, temporary-directory variables, locale, and certificate locations. Hosts may add explicit environment values through the programmatic API. Ambient credentials are not inherited.
