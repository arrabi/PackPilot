import { createServer } from "node:http";
import { createHandler } from "../supabase/functions/_shared/handler.ts";

process.loadEnvFile(".env");
const required = (key: string) => {
  const value = process.env[key];
  if (!value) throw new Error(`Missing ${key} in .env`);
  return value;
};
const handler = createHandler({ supabaseUrl: required("SUPABASE_URL"), publishableKey: required("SUPABASE_ANON_KEY"), resourceUrl: required("MCP_RESOURCE_URL"), allowedOrigin: required("AUTH_UI_ORIGIN") });
createServer(async (incoming, outgoing) => {
  const requestHeaders = new Headers();
  for (const [key, value] of Object.entries(incoming.headers)) if (value) requestHeaders.set(key, Array.isArray(value) ? value.join(", ") : value);
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of incoming) {
    bytes += chunk.length;
    if (bytes > 65536) { outgoing.writeHead(413); outgoing.end(); return; }
    chunks.push(chunk);
  }
  const request = new Request(`http://localhost:8787${incoming.url}`, { method: incoming.method, headers: requestHeaders, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) });
  try {
    const response = await handler(request);
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) for await (const chunk of response.body) outgoing.write(chunk);
    outgoing.end();
  } catch { outgoing.writeHead(500); outgoing.end("Service unavailable"); }
}).listen(8787, "127.0.0.1", () => console.log("MCP development server: http://localhost:8787/functions/v1/scouts-mcp"));
