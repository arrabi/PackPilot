-- The scheduler's credential lives in Vault, never in cron command text.
create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;
create table private.pack_notification_settings (
 singleton boolean primary key default true check(singleton), endpoint text not null
);
alter table private.pack_notification_settings enable row level security;
revoke all on private.pack_notification_settings from public,anon,authenticated;
create function private.invoke_parent_notification_dispatch() returns bigint
language plpgsql security definer set search_path='' as $$
declare endpoint text; dispatch_key text; request_id bigint;
begin
 select s.endpoint into endpoint from private.pack_notification_settings s where singleton;
 select decrypted_secret into dispatch_key from vault.decrypted_secrets where name='pack99_notification_dispatch_secret';
 if endpoint is null or dispatch_key is null then raise exception 'Notification scheduler is not configured';end if;
 select net.http_post(url:=endpoint,body:='{}'::jsonb,
 headers:=jsonb_build_object('Content-Type','application/json','x-pack99-dispatch-key',dispatch_key),
 timeout_milliseconds:=120000)into request_id;
 return request_id;
end;$$;
revoke all on function private.invoke_parent_notification_dispatch()from public,anon,authenticated;
-- Deployment configures Vault and the endpoint before enabling the cron job.
