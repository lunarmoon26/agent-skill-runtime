import { writeFile } from "node:fs/promises"

process.on("SIGTERM", () => {})
await writeFile(process.argv[2], "ready")
await new Promise((resolve) => setTimeout(resolve, 650))
await writeFile(process.argv[2], "survived")
await new Promise((resolve) => setTimeout(resolve, 10_000))
