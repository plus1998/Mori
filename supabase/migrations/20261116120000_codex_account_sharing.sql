-- Only account references and explicit PC grants live in the Center. Tokens are
-- exchanged over private Realtime channels and never written to this table.
create table public.codex_account_shares (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  owner_device_id uuid not null references public.devices(id) on delete cascade,
  recipient_device_id uuid not null references public.devices(id) on delete cascade,
  account_id text not null check (account_id ~ '^oa_[A-Za-z0-9_-]+$'),
  account_name text not null check (length(account_name) between 1 and 200),
  chatgpt_account_id text not null check (length(chatgpt_account_id) between 1 and 200),
  grant_epoch uuid not null default gen_random_uuid(),
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  check (owner_device_id <> recipient_device_id),
  unique (owner_device_id, account_id, recipient_device_id)
);
create index codex_account_shares_recipient_idx on public.codex_account_shares(recipient_device_id);
alter table public.codex_account_shares enable row level security;
revoke all on public.codex_account_shares from anon, authenticated;
grant select on public.codex_account_shares to authenticated;

create function public.eco_can_access_codex_share(p_share_id uuid, p_active_only boolean default true)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.codex_account_shares s
    join public.devices owner on owner.id = s.owner_device_id
      and owner.user_id = s.user_id and owner.kind = 'desktop' and owner.disabled_at is null
    join public.devices recipient on recipient.id = s.recipient_device_id
      and recipient.user_id = s.user_id and recipient.kind = 'desktop' and recipient.disabled_at is null
    where s.id = p_share_id and s.user_id = (select auth.uid())
      and (select public.eco_current_device_id()) in (s.owner_device_id, s.recipient_device_id)
      and (not p_active_only or s.revoked_at is null)
  );
$$;
revoke all on function public.eco_can_access_codex_share(uuid, boolean) from public;
grant execute on function public.eco_can_access_codex_share(uuid, boolean) to authenticated;
create policy codex_shares_select on public.codex_account_shares for select to authenticated
  using (public.eco_can_access_codex_share(id, false));

-- The authenticated device can publish only its own local account. A recipient
-- can neither grant itself access nor change the account/owner of a grant.
create function public.eco_set_codex_account_shares(
  p_account_id text, p_account_name text, p_chatgpt_account_id text, p_device_ids uuid[]
) returns void language plpgsql security definer set search_path = '' as $$
declare
  caller_id uuid := (select auth.uid());
  owner_id uuid := (select public.eco_current_device_id());
begin
  if caller_id is null or owner_id is null or not exists (
    select 1 from public.devices where id = owner_id and user_id = caller_id
      and kind = 'desktop' and disabled_at is null
  ) then
    raise exception 'An active desktop session is required.' using errcode = '42501';
  end if;
  if p_account_id is null or p_account_id !~ '^oa_[A-Za-z0-9_-]+$'
    or p_account_name is null or length(trim(p_account_name)) not between 1 and 200
    or p_chatgpt_account_id is null or length(trim(p_chatgpt_account_id)) not between 1 and 200
    or p_device_ids is null or cardinality(p_device_ids) > 100 then
    raise exception 'Invalid account sharing request.' using errcode = '22023';
  end if;
  if exists (
    select 1 from unnest(p_device_ids) target(id)
    where target.id is null or target.id = owner_id or not exists (
      select 1 from public.devices d where d.id = target.id and d.user_id = caller_id
        and d.kind = 'desktop' and d.disabled_at is null
    )
  ) then
    raise exception 'Recipients must be active PCs on the same account.' using errcode = '42501';
  end if;
  -- Serialize edits for one owner/account, including concurrent windows.
  perform pg_advisory_xact_lock(hashtextextended(owner_id::text || ':' || p_account_id, 0));
  update public.codex_account_shares set revoked_at = now()
    where owner_device_id = owner_id and account_id = p_account_id
      and not (recipient_device_id = any(p_device_ids)) and revoked_at is null;
  insert into public.codex_account_shares as existing
    (user_id, owner_device_id, recipient_device_id, account_id, account_name, chatgpt_account_id)
  select caller_id, owner_id, target.id, p_account_id, trim(p_account_name), trim(p_chatgpt_account_id)
    from (select distinct unnest(p_device_ids) as id) target
  on conflict (owner_device_id, account_id, recipient_device_id) do update set
    account_name = excluded.account_name,
    chatgpt_account_id = excluded.chatgpt_account_id,
    grant_epoch = case when existing.revoked_at is not null
      or existing.chatgpt_account_id <> excluded.chatgpt_account_id
      then gen_random_uuid() else existing.grant_epoch end,
    revoked_at = null;
end;
$$;
revoke all on function public.eco_set_codex_account_shares(text, text, text, uuid[]) from public;
grant execute on function public.eco_set_codex_account_shares(text, text, text, uuid[]) to authenticated;

create function public.eco_codex_topic_share_id(topic text)
returns uuid language sql immutable strict set search_path = '' as $$
  select case when topic ~ '^eco:codex:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then substring(topic from 11)::uuid else null end;
$$;
revoke all on function public.eco_codex_topic_share_id(text) from public;
grant execute on function public.eco_codex_topic_share_id(text) to authenticated;

create policy codex_share_realtime_select on realtime.messages for select to authenticated
  using (public.eco_can_access_codex_share(public.eco_codex_topic_share_id(realtime.topic())));
create policy codex_share_realtime_insert on realtime.messages for insert to authenticated
  with check (public.eco_can_access_codex_share(public.eco_codex_topic_share_id(realtime.topic())));
