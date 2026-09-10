for await (const _chunk of process.stdin) {
  // Consume the complete request before waiting.
}
await new Promise((resolve) => setTimeout(resolve, 10_000))
process.stdout.write('{"ok":true}\n')
