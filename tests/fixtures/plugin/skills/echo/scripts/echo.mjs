let input = ""
for await (const chunk of process.stdin) input += chunk
const value = JSON.parse(input)
process.stdout.write(`${JSON.stringify({
  echo: value.message,
  cwd: process.cwd(),
  explicitEnvironment: process.env.RUNTIME_TEST_VALUE ?? null,
  hiddenEnvironment: process.env.RUNTIME_HIDDEN_VALUE ?? null,
})}\n`)
