for await (const _chunk of process.stdin) {
  // Consume the complete request before responding.
}
process.stdout.write('"scalar"\n')
