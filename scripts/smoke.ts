// Live checks require a real approved user token in the shell environment.
// Never put a token in command-line arguments or print roster responses.
import { existsSync } from "node:fs";
export {};
if (existsSync(".env")) process.loadEnvFile(".env");
const endpoint = process.env.MCP_RESOURCE_URL;
const token = process.env.SCOUTS_USER_ACCESS_TOKEN;
if (!endpoint || !token) throw new Error("Set MCP_RESOURCE_URL in .env and SCOUTS_USER_ACCESS_TOKEN in your shell environment.");
const metadata = await fetch(`${endpoint.replace(/\/$/, "")}/.well-known/oauth-protected-resource`);
if (!metadata.ok) throw new Error("OAuth resource discovery failed");
const discovery = await metadata.json();
if (discovery.resource !== endpoint) throw new Error("OAuth resource URL mismatch");
const unauthorized = await fetch(endpoint);
if (unauthorized.status !== 401) throw new Error("Unauthenticated request was not challenged");
for (const [method, params] of [
  ["initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "pack99-smoke", version: "0.1.0" } }],
  ["tools/list", {}],
  ["tools/call", { name: "query_roster", arguments: { limit: 1, metrics: [{ op: "count" }] } }],
  ["tools/call", { name: "read_pack_advancement", arguments: { entity: "adventures", page_limit: 1 } }],
  ["tools/call", { name: "read_pack_equipment", arguments: { entity: "eligibility", scouting_year: "2026-27", page_limit: 1 } }],
  ["tools/call", { name: "read_pack_den_plans", arguments: { scouting_year: "2026-27" } }],
  ["tools/call", { name: "read_pack_inventory", arguments: { entity: "items", page_limit: 1 } }],
  ["tools/call", { name: "read_pack_report", arguments: { report: "scout_summary", scouting_year: "2026-27", page_limit: 1 } }],
] as const) {
  const response = await fetch(endpoint, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-03-26" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  if (!response.ok) throw new Error(`${method} failed with HTTP ${response.status}`);
  const text = await response.text();
  const dataLine = text.split("\n").filter(l => l.startsWith("data: ")).at(-1);
  const payload = JSON.parse(dataLine ? dataLine.slice(6) : text);
  if (payload.error || payload.result?.isError) throw new Error(`${method} returned an error`);
  if (method === "tools/list") {
    const names = new Set((payload.result?.tools ?? []).map((tool: { name: string }) => tool.name));
    for (const name of ["describe_roster", "query_roster", "describe_operations", "read_pack_operations", "read_pack_advancement", "read_pack_equipment", "read_pack_inventory", "read_pack_den_plans", "read_pack_report", "record_pack_operation", "record_pack_batch"]) {
      if (!names.has(name)) throw new Error(`M2 tool missing: ${name}`);
    }
  }
  console.log(`${method}${"name" in params ? ` ${params.name}` : ""}: passed`);
}
