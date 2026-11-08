create table private.site_policy_versions (
 version text primary key,terms text not null,privacy text not null,
 terms_hash text not null,privacy_hash text not null,current boolean not null default false,
 published_at timestamptz not null default now()
);
create unique index one_current_site_policy on private.site_policy_versions(current)where current;
create table private.site_policy_acceptances (
 user_id uuid not null references auth.users(id),version text not null references private.site_policy_versions(version),
 terms_hash text not null,privacy_hash text not null,accepted_at timestamptz not null default now(),
 primary key(user_id,version)
);
alter table private.site_policy_versions enable row level security;
alter table private.site_policy_acceptances enable row level security;
revoke all on private.site_policy_versions,private.site_policy_acceptances from public,anon,authenticated;
insert into private.site_policy_versions(version,terms,privacy,terms_hash,privacy_hash,current)values('2026-11-02.1','# Terms of Use — operator template

This is a template for the organization operating this PackPilot instance. Review and replace it before collecting real records.

## Operator and contact

The operator is YOUR_ORGANIZATION. Contact contact@example.test for access, corrections, support and requests.

## Intended use

Authorized leaders record scouting activities, attendance, advancement and equipment. Parents access only their verified family relationships. Official scouting requirements and national registration systems remain authoritative.

## Responsibilities

Keep your sign-in secure. Enter accurate information, respect family privacy, and obtain appropriate permissions for photos and records. Do not upload medical information, credentials or unrelated sensitive records.

## Availability and changes

The operator maintains access controls, backups and versioned policies. Service can pause for maintenance. Review changes before accepting a new version.

This template is not a substitute for review of the operator''s actual practices and obligations.
','# Privacy Policy — operator template

Review and complete this template before collecting real records.

## Operator

YOUR_ORGANIZATION operates this instance. Contact contact@example.test for questions, access corrections, exports and deletion requests.

## Records and access

The service stores the roster and family contact details supplied by the operator, attendance, advancement, assignments, messages and equipment records. Approved leaders have role-based access; parents access their verified family scope. The operator must document its retention periods and review permissions regularly.

## Services

The configured providers are Supabase for database/authentication/functions, Cloudflare for website hosting and optional private backups, Google for sign-in, and Brevo for configured email delivery. Replace this list if your deployment differs. Secrets belong in provider settings, not source control.

## AI integrations

MCP access uses the caller''s authenticated permissions. If a user connects an AI client, permitted records sent to that client are subject to that client''s practices. The operator must review and explain its supported integrations.

## Backups and requests

The operator must specify backup locations, retention periods, security practices and handling of exports or deletion requests. Do not store medical notes or unrelated sensitive information.

This template describes the application model, not a completed privacy assessment for every operator.
','89bf6d52c51d1cca21066590a59d13aadaac1a70e4b9f8ea76c2ccfd0611c34c','fe2c344d63d2e4a982f86010901a49bd1e838d34f4410b3d8cef30201dd9f755',true);

create function private.leader_identity_approved() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.leader_access a
    join auth.users u on private.canonical_leader_email(u.email) = private.canonical_leader_email(a.email)
    join auth.identities i on i.user_id = u.id and i.provider = 'google'
    where u.id = auth.uid() and a.active
      and u.email_confirmed_at is not null
      and private.canonical_leader_email(i.identity_data->>'email') = private.canonical_leader_email(a.email)
      and i.identity_data->>'email_verified' = 'true'
  );
$$;

revoke all on function private.leader_identity_approved()from public,anon,authenticated;
create function private.has_accepted_site_policies()returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from private.site_policy_acceptances a join private.site_policy_versions p on p.version=a.version
 join auth.users u on u.id=a.user_id where a.user_id=auth.uid()and u.email_confirmed_at is not null and p.current and a.terms_hash=p.terms_hash and a.privacy_hash=p.privacy_hash);
$$;
revoke all on function private.has_accepted_site_policies()from public,anon,authenticated;
create function private.site_policy_eligible()returns boolean
language sql stable security definer set search_path='' as $$
 select private.leader_identity_approved()or exists(
 select 1 from public.parent_scout_links l join auth.users u on private.canonical_leader_email(u.email)=l.email_canonical
 join public.scouts s on s.id=l.scout_id
 where u.id=auth.uid()and u.email_confirmed_at is not null and l.active and(l.claimed_user_id is null or l.claimed_user_id=u.id)and coalesce(s.den,'')!~* '^\s*\(withdraw\)');
$$;
revoke all on function private.site_policy_eligible()from public,anon,authenticated;
create function public.get_site_policy_status()returns jsonb
language sql stable security definer set search_path='' as $$
 select jsonb_build_object('eligible',private.site_policy_eligible(),'accepted',private.has_accepted_site_policies(),'version',p.version,'terms_hash',p.terms_hash,'privacy_hash',p.privacy_hash,'terms',p.terms,'privacy',p.privacy)from private.site_policy_versions p where p.current;
$$;
create function public.accept_site_policies(policy_version text,terms_hash text,privacy_hash text)returns void
language plpgsql security definer set search_path='' as $$
declare policy private.site_policy_versions;
begin
 if not private.site_policy_eligible()then raise exception 'Approved leader or authorized parent account required'using errcode='42501';end if;
 select * into policy from private.site_policy_versions p where p.current for share;
 if policy.version is distinct from policy_version or policy.terms_hash is distinct from terms_hash or policy.privacy_hash is distinct from privacy_hash then raise exception 'Policies changed; reload before accepting'using errcode='22023';end if;
 insert into private.site_policy_acceptances(user_id,version,terms_hash,privacy_hash)values(auth.uid(),policy.version,policy.terms_hash,policy.privacy_hash)on conflict do nothing;
end;$$;
revoke all on function public.get_site_policy_status(),public.accept_site_policies(text,text,text)from public,anon;
grant execute on function public.get_site_policy_status(),public.accept_site_policies(text,text,text)to authenticated;

-- Preserve existing function OIDs: every existing policy/RPC gains the gate.
create or replace function private.is_approved_leader()returns boolean
language sql stable security definer set search_path='' as $$
 select private.leader_identity_approved()and private.has_accepted_site_policies();
$$;
create or replace function private.parent_can_read_scout(child uuid)returns boolean
language sql stable security definer set search_path='' as $$
 select private.has_accepted_site_policies()and exists(
 select 1 from public.parent_scout_links l join auth.users u on u.id=l.claimed_user_id join public.scouts s on s.id=l.scout_id
 where l.scout_id=child and l.active and u.id=auth.uid()and u.email_confirmed_at is not null
 and private.canonical_leader_email(u.email)=l.email_canonical and coalesce(s.den,'')!~* '^\s*\(withdraw\)');
$$;
revoke all on function private.parent_can_read_scout(uuid)from public,anon,authenticated;
-- Parent link claiming is also a protected operation, while OTP delivery remains independent.
create or replace function public.claim_parent_links()returns integer
language plpgsql security definer set search_path='' set statement_timeout='5s' as $$
declare mailbox text;claimed integer;
begin
 if not private.has_accepted_site_policies()then raise exception 'Accept the website Terms of Use and Privacy Policy before continuing'using errcode='42501';end if;
 select private.canonical_leader_email(u.email)into mailbox from auth.users u where u.id=auth.uid()and u.email_confirmed_at is not null;
 if mailbox is null then raise exception 'Verified email required'using errcode='42501';end if;
 update public.parent_scout_links l set claimed_user_id=auth.uid(),claimed_at=now()
 where l.active and l.email_canonical=mailbox and l.claimed_user_id is null and exists(select 1 from public.scouts s where s.id=l.scout_id and coalesce(s.den,'')!~* '^\s*\(withdraw\)');
 get diagnostics claimed=row_count;return claimed;
end;$$;
