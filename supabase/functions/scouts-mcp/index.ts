import { createHandler } from "../_shared/handler.ts";
import { deploymentOrigins } from '../_shared/deployment-origins.ts';

const required = (key: string) => {
  const value = Deno.env.get(key);
  if (!value) throw new Error(`Missing required configuration: ${key}`);
  return value;
};

const supabaseUrl = required("SUPABASE_URL");
const { allowedOrigin, allowedOrigins } = deploymentOrigins(supabaseUrl, Deno.env.get('PACK99_ENVIRONMENT'), Deno.env.get('AUTH_UI_ORIGIN'));
Deno.serve(createHandler({
  supabaseUrl,
  publishableKey: Deno.env.get("APP_SUPABASE_PUBLISHABLE_KEY") ?? required("SUPABASE_ANON_KEY"),
  // Public deployment defaults; no privileged project key is used.
  resourceUrl: Deno.env.get("MCP_RESOURCE_URL") ?? `${supabaseUrl}/functions/v1/scouts-mcp`,
  allowedOrigin,
  // Keep the existing Pages portal and its new custom hostname working together.
  // Exact origins only: no wildcard subdomains or lookalike hosts.
  allowedOrigins,
}));
