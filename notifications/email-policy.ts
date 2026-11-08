export interface EmailPolicy {
  SUPABASE_URL?: string;
  PACK99_ENVIRONMENT?: string;
  PACK99_EMAIL_ALLOWLIST?: string;
  PACK99_AUTH_UI_ORIGIN?: string;
}
export const stagingRecipient = 'staging@example.test';
const productionOrigins = ['https://packpilot.example', 'https://legacy.packpilot.example', 'https://packpilot-site.pages.dev'];

export function stagingOrigin(env: EmailPolicy): string {
  const url = new URL(env.PACK99_AUTH_UI_ORIGIN || '');
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash || productionOrigins.includes(url.origin)) {
    throw Error('Invalid staging website origin');
  }
  return url.origin;
}

export function emailAllowed(env: EmailPolicy, recipients: string[]): boolean {
  // Existing production deployments retain their behavior during setup.
  if (!env.PACK99_ENVIRONMENT || env.PACK99_ENVIRONMENT === 'production') {
    return env.SUPABASE_URL === 'https://aaaaaaaaaaaaaaaaaaaa.supabase.co';
  }
  if (env.PACK99_ENVIRONMENT !== 'staging') return false;
  try { stagingOrigin(env); } catch { return false; }
  return env.PACK99_EMAIL_ALLOWLIST === stagingRecipient && recipients.length > 0 &&
    recipients.every(recipient => recipient.trim().toLowerCase() === stagingRecipient);
}

export function stagingContent(env: EmailPolicy, content: string): string {
  if (env.PACK99_ENVIRONMENT !== 'staging') return content;
  const origin = stagingOrigin(env);
  // Generated database links still use the production hostname. Change only known
  // application origins, preserving path/query; recipient addresses are never rewritten.
  for (const production of productionOrigins) content = content.replaceAll(production, origin);
  return content;
}
