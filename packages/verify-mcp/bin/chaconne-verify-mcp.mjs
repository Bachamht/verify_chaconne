#!/usr/bin/env node
// stdio MCP 入口（通过 tsx 运行 TS 源；发布时可改为编译产物）
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
const here = dirname(fileURLToPath(import.meta.url));
const tsx = createRequire(join(here, "..", "package.json")).resolve("tsx/cli");
const child = spawn(process.execPath, [tsx, join(here, "..", "src", "stdio.ts")], { stdio: "inherit", env: process.env });
child.on("exit", (c) => process.exit(c ?? 0));
