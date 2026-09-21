#!/usr/bin/env node
// Reproducible source-tree hash: sha256 over sorted "path\0sha256(bytes)\n" for every tracked file except the two release stamps.
// Compare the output with docs/RELEASE.json.treeHash and with the deployed service's GET /healthz → release.treeHash.
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
const files = execSync("git ls-files -z", { encoding: "utf8" }).split("\0").filter((f) => f && f !== "docs/RELEASE.json" && f !== "apps/verify-service/release.json").sort();
const h = createHash("sha256");
for (const f of files) h.update(f + "\0" + createHash("sha256").update(readFileSync(f)).digest("hex") + "\n");
console.log(h.digest("hex"), files.length + " files");
