-- Membership identity is separate from yearly registration status.
-- Preserve the original string, including any leading zeros.
alter table public.scouts add column bsa_member_id text
  check(bsa_member_id is null or bsa_member_id ~ '^[0-9]{1,20}$');
create unique index scouts_bsa_member_id_key on public.scouts(bsa_member_id) where bsa_member_id is not null;
comment on column public.scouts.bsa_member_id is 'Scouting America/BSA member number matched to a national youth record. Not proof of registration in any specific year; consult pack_registrations. Protected by existing approved-leader roster RLS.';
