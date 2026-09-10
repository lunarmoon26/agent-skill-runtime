for await (const _chunk of process.stdin) {
  // Consume the complete request before responding.
}
process.stdout.write(Buffer.from([0x22, 0xc3, 0x28, 0x22, 0x0a]))
