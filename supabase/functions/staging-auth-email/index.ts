import {handleAuthEmail} from '../../../notifications/auth-email.ts';
Deno.serve(request => handleAuthEmail(request, {
  SUPABASE_URL: Deno.env.get('SUPABASE_URL') || '',
  PACK99_DATABASE_KEY: Deno.env.get('PACK99_DATABASE_KEY') || '',
  PACK99_ENVIRONMENT: Deno.env.get('PACK99_ENVIRONMENT'),
  PACK99_EMAIL_ALLOWLIST: Deno.env.get('PACK99_EMAIL_ALLOWLIST'),
  PACK99_AUTH_UI_ORIGIN: Deno.env.get('PACK99_AUTH_UI_ORIGIN'),
  AUTH_EMAIL_HOOK_SECRET: Deno.env.get('AUTH_EMAIL_HOOK_SECRET') || '',
  BREVO_API_KEY: Deno.env.get('BREVO_API_KEY') || '',
  FROM_EMAIL: Deno.env.get('PACK99_FROM_EMAIL') || '',
}));
