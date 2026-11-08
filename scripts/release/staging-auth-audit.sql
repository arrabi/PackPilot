-- Installed only by configure-staging.py after its staging-project guard.
-- No email addresses, login links, tokens or callback bodies are retained.
create table if not exists private.pack_staging_auth_mail_checks (
  webhook_id text primary key,
  recipient_sha256 text not null,
  decision text not null check (decision in ('blocked','accepted')),
  provider_message_id text,
  checked_at timestamptz not null default now(),
  check ((decision='accepted') = (provider_message_id is not null))
);
alter table private.pack_staging_auth_mail_checks enable row level security;
revoke all on private.pack_staging_auth_mail_checks from public,anon,authenticated,service_role;
create or replace function public.record_staging_auth_mail_check(
  webhook_id text, recipient_sha256 text, decision text, provider_message_id text
) returns void language plpgsql security definer set search_path='' as $$
begin
  if length(webhook_id) not between 1 and 256 or recipient_sha256 !~ '^[a-f0-9]{64}$' then
    raise exception 'Invalid staging mail evidence';
  end if;
  insert into private.pack_staging_auth_mail_checks values
    (webhook_id,recipient_sha256,decision,provider_message_id,now())
    on conflict on constraint pack_staging_auth_mail_checks_pkey do nothing;
  delete from private.pack_staging_auth_mail_checks where checked_at < now()-interval '1 day';
end $$;
revoke all on function public.record_staging_auth_mail_check(text,text,text,text) from public,anon,authenticated;
grant execute on function public.record_staging_auth_mail_check(text,text,text,text) to service_role;
notify pgrst, 'reload schema';
