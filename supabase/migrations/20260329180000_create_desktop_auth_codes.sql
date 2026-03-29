-- WHY: Desktop (Tauri) login delegates auth to the system browser.
-- After login, the browser exchanges session tokens for a one-time code
-- that the desktop app redeems via PKCE (code_verifier/code_challenge).
-- This table stores the short-lived mapping between code and tokens.

create table if not exists public.desktop_auth_codes (
  auth_code    text        primary key,
  code_challenge text      not null,
  access_token text        not null,
  refresh_token text       not null,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null
);

-- WHY: No RLS policies — only the Rust API (superuser connection pool) accesses this table.
-- End users never query it directly.
alter table public.desktop_auth_codes enable row level security;

-- WHY: Auto-cleanup expired codes. Runs on every insert to keep the table small.
-- A dedicated cron would be overkill for a table that rarely exceeds a few rows.
create or replace function public.cleanup_expired_desktop_auth_codes()
returns trigger
language plpgsql
security definer
as $$
begin
  delete from public.desktop_auth_codes where expires_at < now();
  return new;
end;
$$;

create trigger trg_cleanup_expired_desktop_auth_codes
  after insert on public.desktop_auth_codes
  for each row
  execute function public.cleanup_expired_desktop_auth_codes();
