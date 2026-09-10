for await (const _chunk of process.stdin) {
  // Consume the complete request before producing a result.
}
process.stdout.write('{"ok":true}\n')
