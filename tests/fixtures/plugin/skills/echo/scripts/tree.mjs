import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

let input = ""
for await (const chunk of process.stdin) input += chunk
const { marker } = JSON.parse(input)
spawn(process.execPath, [fileURLToPath(new URL("tree-child.mjs", import.meta.url)), marker], { stdio: "ignore" })
await new Promise((resolve) => setTimeout(resolve, 10_000))
process.stdout.write('{"ok":true}\n')
