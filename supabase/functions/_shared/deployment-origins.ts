const productionUrl = 'https://aaaaaaaaaaaaaaaaaaaa.supabase.co';
const stagingUrl = 'https://bbbbbbbbbbbbbbbbbbbb.supabase.co';
const productionOrigins = ['https://packpilot-site.pages.dev', 'https://packpilot.example', 'https://legacy.packpilot.example'] as const;
const stagingOrigins = ['https://packpilot-staging.pages.dev', 'https://staging.packpilot.example'] as const;

export function deploymentOrigins(supabaseUrl: string, environment?: string, configuredOrigin?: string) {
  const staging = environment === 'staging';
  const allowedOrigin = (configuredOrigin ?? 'https://packpilot.example').replace(/\/$/, '');
  const allowedOrigins: readonly string[] = staging ? stagingOrigins : productionOrigins;
  if (supabaseUrl.replace(/\/$/, '') !== (staging ? stagingUrl : productionUrl) || !allowedOrigins.includes(allowedOrigin)) {
    throw new Error('The MCP project and browser origins must match the deployment environment');
  }
  return { allowedOrigin, allowedOrigins };
}
