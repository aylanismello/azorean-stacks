-- The /lol board: one card per granular thing that has been built and not yet
-- confirmed by a human at the device. Two columns and nothing else — "built" is
-- a claim, "verified" is Aylan having actually seen it work. The point is that
-- the second column is the only one that counts, and that it is moved by hand.
create table if not exists public.lol_items (
  id uuid primary key default gen_random_uuid(),
  title text not null check (length(title) between 1 and 300),
  -- how to check it: the steps, in the order a person would do them
  detail text,
  -- the auto-group a card falls into, e.g. 'Sync', 'Rekordbox', 'Tape'
  area text not null default 'General' check (length(area) between 1 and 80),
  -- where it came from: a repo, a doc, a commit
  source text,
  status text not null default 'built' check (status in ('built', 'verified')),
  -- what the human said when they checked it — the half a commit message never holds
  notes text,
  sort integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  verified_at timestamptz
);

create index if not exists lol_items_status_idx on public.lol_items(status);
create index if not exists lol_items_area_idx on public.lol_items(area);

-- `verified_at` is derived, never typed: a card is stamped when it crosses and
-- un-stamped if it is sent back, so the column can never disagree with `status`.
create or replace function public.lol_items_touch()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  new.updated_at := now();
  if new.status = 'verified' then
    if tg_op = 'INSERT' or old.status is distinct from 'verified' then
      new.verified_at := coalesce(new.verified_at, now());
    end if;
  else
    new.verified_at := null;
  end if;
  return new;
end;
$$;

drop trigger if exists lol_items_touch_trigger on public.lol_items;
create trigger lol_items_touch_trigger
  before insert or update on public.lol_items
  for each row execute function public.lol_items_touch();

alter table public.lol_items enable row level security;

-- One person's board. The app's middleware already turns away anyone without a
-- session; this is the half that does not depend on the app being right.
drop policy if exists "Owner reads the board" on public.lol_items;
create policy "Owner reads the board" on public.lol_items for select
  using ((auth.jwt() ->> 'email') = 'hi@aylan.io');

drop policy if exists "Owner adds cards" on public.lol_items;
create policy "Owner adds cards" on public.lol_items for insert
  with check ((auth.jwt() ->> 'email') = 'hi@aylan.io');

drop policy if exists "Owner moves cards" on public.lol_items;
create policy "Owner moves cards" on public.lol_items for update
  using ((auth.jwt() ->> 'email') = 'hi@aylan.io')
  with check ((auth.jwt() ->> 'email') = 'hi@aylan.io');

drop policy if exists "Owner removes cards" on public.lol_items;
create policy "Owner removes cards" on public.lol_items for delete
  using ((auth.jwt() ->> 'email') = 'hi@aylan.io');

revoke all on public.lol_items from anon;
grant select, insert, update, delete on public.lol_items to authenticated;
grant all on public.lol_items to service_role;
