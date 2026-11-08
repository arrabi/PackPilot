-- The provider owns pg_net's tables. Never place the reusable Vault key in its
-- request queue: use a short-lived HMAC proof and a one-use nonce instead.
create extension if not exists pgcrypto with schema extensions;
create table private.pack_notification_invocations (
 nonce uuid primary key, recorded_at timestamptz not null default now()
);
alter table private.pack_notification_invocations enable row level security;
revoke all on private.pack_notification_invocations from public,anon,authenticated;
create function public.reserve_parent_notification_run(invocation_nonce uuid,issued_at bigint)returns boolean
language plpgsql security definer set search_path='' as $$
begin
 if invocation_nonce is null or issued_at is null or issued_at<extract(epoch from now())-300 or issued_at>extract(epoch from now())+30 then return false;end if;
 delete from private.pack_notification_invocations where recorded_at<now()-interval '1 day';
 insert into private.pack_notification_invocations(nonce)values(invocation_nonce)on conflict do nothing;
 return found;
end;$$;
revoke all on function public.reserve_parent_notification_run(uuid,bigint)from public,anon,authenticated;
grant execute on function public.reserve_parent_notification_run(uuid,bigint)to service_role;
create or replace function private.invoke_parent_notification_dispatch()returns bigint
language plpgsql security definer set search_path='' as $$
declare endpoint text; dispatch_key text; request_id bigint; issued text:=floor(extract(epoch from now()))::bigint::text; nonce text:=gen_random_uuid()::text; proof text;
begin
 select s.endpoint into endpoint from private.pack_notification_settings s where singleton;
 select decrypted_secret into dispatch_key from vault.decrypted_secrets where name='pack99_notification_dispatch_secret';
 if endpoint is null or dispatch_key is null then raise exception 'Notification scheduler is not configured';end if;
 proof:=issued||':'||nonce||':'||encode(extensions.hmac('pack99-parent-notifications:'||issued||':'||nonce,dispatch_key,'sha256'),'hex');
 select net.http_post(url:=endpoint,body:='{}'::jsonb,headers:=jsonb_build_object('Content-Type','application/json','x-pack99-dispatch-key',proof),timeout_milliseconds:=120000)into request_id;
 return request_id;
end;$$;
