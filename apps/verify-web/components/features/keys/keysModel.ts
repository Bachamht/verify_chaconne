/** Agent 接入 key（v8）的纯逻辑：签发消息字段、MCP 配置与 curl 示例（与 v7 ApiKeys 一致）。 */

export const SERVICE_URL = process.env["NEXT_PUBLIC_PUBLIC_SERVICE_URL"] ?? "https://verify.chaconne.xyz";

export function randomHex(bytes: number): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** 名称留空时的默认名；去掉首尾空白并按上限截断 */
export function keyLabel(input: string, zh: boolean, maxChars: number): string {
  const s = input.trim() || (zh ? "我的 Agent" : "My agent");
  return Array.from(s).slice(0, maxChars).join("");
}

export function mcpConfig(apiKey: string, service: string = SERVICE_URL): string {
  return JSON.stringify({
    mcpServers: {
      "chaconne-verify": {
        command: "node",
        args: ["<path-to>/verify_chaconne/packages/verify-mcp/bin/chaconne-verify-mcp.mjs"],
        env: { VERIFY_SERVICE_URL: service, VERIFY_API_KEY: apiKey },
      },
    },
  }, null, 2);
}

export function curlExample(apiKey: string, owner: string, service: string = SERVICE_URL): string {
  return `curl -H "x-api-key: ${apiKey}" "${service}/v1/tasks?owner=${owner}"`;
}
