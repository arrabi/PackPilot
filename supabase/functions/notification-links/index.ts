import{handleNotificationLink}from'../../../notifications/tracking.ts';
Deno.serve(request=>handleNotificationLink(request,{SUPABASE_URL:Deno.env.get('SUPABASE_URL')||'',SUPABASE_SECRET_KEY:Deno.env.get('PACK99_DATABASE_KEY')||'',PACK99_ENVIRONMENT:Deno.env.get('PACK99_ENVIRONMENT'),PACK99_AUTH_UI_ORIGIN:Deno.env.get('PACK99_AUTH_UI_ORIGIN')}));
