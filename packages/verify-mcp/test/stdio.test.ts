/** 真实 stdio 传输：spawn 入口进程，官方 Client 经 StdioClientTransport 握手 + 调用；后端为本地 HTTP 假服务。 */
import { createServer } from "node:http";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createRequire } from "node:module";
import { TOOL_NAMES } from "../src/server";
const TSX = createRequire(import.meta.url).resolve("tsx/cli");

let port = 0;
const http = createServer((req, res) => {
  const ok = (o: unknown) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(o));
  };
  if (req.url === "/v1/assets") return ok({ registryVersion: "t", registryHash: "0x", evidenceMode: "FIXTURE", assets: [] });
  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
});

beforeAll(async () => {
  await new Promise<void>((r) => http.listen(0, "127.0.0.1", () => r()));
  port = (http.address() as { port: number }).port;
});
afterAll(() => http.close());

describe("stdio 传输（I-03 LIVE 客户端日志）", () => {
  it("spawn → initialize → listTools → callTool(list_supported_assets)", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [TSX, join(__dirname, "..", "src", "stdio.ts")],
      env: { ...process.env, VERIFY_SERVICE_URL: `http://127.0.0.1:${port}`, VERIFY_API_KEY: "k", PATH: process.env["PATH"] ?? "" },
      stderr: "pipe",
    });
    const client = new Client({ name: "stdio-test", version: "0.0.0" });
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.length).toBe(TOOL_NAMES.length);
    const r = await client.callTool({ name: "list_supported_assets", arguments: {} });
    expect((r.structuredContent as { evidenceMode: string }).evidenceMode).toBe("FIXTURE");
    await client.close();
  }, 60_000);

  it("agent-wallet 三项齐全 → 启动（工具数不变）；只给私钥不给额度/链 → 拒绝启动", async () => {
    const full = new StdioClientTransport({
      command: process.execPath,
      args: [TSX, join(__dirname, "..", "src", "stdio.ts")],
      env: { ...process.env, VERIFY_SERVICE_URL: `http://127.0.0.1:${port}`, VERIFY_API_KEY: "k", AGENT_WALLET_PRIVATE_KEY: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d", AGENT_WALLET_MAX_SPEND_USD: "1", AGENT_WALLET_CHAIN_IDS: "196,1952", PATH: process.env["PATH"] ?? "" },
      stderr: "pipe",
    });
    const client = new Client({ name: "stdio-test", version: "0.0.0" });
    await client.connect(full);
    expect((await client.listTools()).tools.length).toBe(TOOL_NAMES.length);
    await client.close();
    const partial = new StdioClientTransport({
      command: process.execPath,
      args: [TSX, join(__dirname, "..", "src", "stdio.ts")],
      env: { ...process.env, VERIFY_SERVICE_URL: `http://127.0.0.1:${port}`, VERIFY_API_KEY: "k", AGENT_WALLET_PRIVATE_KEY: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d", PATH: process.env["PATH"] ?? "" },
      stderr: "pipe",
    });
    await expect(new Client({ name: "stdio-test", version: "0.0.0" }).connect(partial)).rejects.toBeTruthy();
  }, 90_000);

  it("环境里出现私钥形态变量 → 进程拒绝启动", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [TSX, join(__dirname, "..", "src", "stdio.ts")],
      env: { ...process.env, VERIFY_SERVICE_URL: `http://127.0.0.1:${port}`, VERIFY_API_KEY: "k", DEMO_PRIVATE_KEY: "0x1", PATH: process.env["PATH"] ?? "" },
      stderr: "pipe",
    });
    const client = new Client({ name: "stdio-test", version: "0.0.0" });
    await expect(client.connect(transport)).rejects.toBeTruthy();
  }, 60_000);
});
