import { handleDispatch } from '../../../notifications/handler.ts';
Deno.serve((request: Request) => handleDispatch(request, {
    SUPABASE_URL: Deno.env.get('SUPABASE_URL') || '',
    SUPABASE_SECRET_KEY: Deno.env.get('PACK99_DATABASE_KEY') || '',
    BREVO_API_KEY: Deno.env.get('BREVO_API_KEY') || '',
    FROM_EMAIL: Deno.env.get('PACK99_FROM_EMAIL') || '',
    DISPATCH_SECRET: Deno.env.get('PACK99_DISPATCH_SECRET') || '',
    PACK99_DELIVERY_PAUSED: Deno.env.get('PACK99_DELIVERY_PAUSED'),
    PACK99_ENVIRONMENT: Deno.env.get('PACK99_ENVIRONMENT'),
    PACK99_EMAIL_ALLOWLIST: Deno.env.get('PACK99_EMAIL_ALLOWLIST'),
    PACK99_AUTH_UI_ORIGIN: Deno.env.get('PACK99_AUTH_UI_ORIGIN'),
}));
