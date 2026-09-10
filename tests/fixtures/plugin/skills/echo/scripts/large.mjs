for await (const _chunk of process.stdin) {
  // Consume the complete request before producing a result.
}
process.stdout.write(`${JSON.stringify({ value: "x".repeat(100) })}\n`)
