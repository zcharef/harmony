-- WHY: The desktop login handoff used to FORWARD the web browser session's
-- refresh token: the browser stored its own `refresh_token` here and the
-- desktop redeemed the exact same token. With refresh-token rotation enabled,
-- the still-open web client keeps rotating that shared token family while the
-- desktop is closed, so the desktop's frozen copy gets revoked and forces a
-- re-login on reopen.
--
-- The fix mints a FRESH, INDEPENDENT Supabase session for the user at redeem
-- time (service-role admin path) instead of forwarding the web token. So the
-- one-time code now only needs to bind to the USER who created it — not to any
-- token. We store `user_id` and stop persisting the web session tokens here.
--
-- Non-destructive per ADR-019: add `user_id`, relax the NOT NULL on the legacy
-- token columns so new inserts leave them NULL. The legacy columns are kept in
-- place (never dropped); the ephemeral 60s-TTL rows written by the old code
-- expire on their own.

alter table public.desktop_auth_codes
  add column if not exists user_id uuid;

alter table public.desktop_auth_codes
  alter column access_token drop not null;

alter table public.desktop_auth_codes
  alter column refresh_token drop not null;
