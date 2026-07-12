-- =============================================================
-- Platform-admin audit log — founder (platform owner) actions.
--
-- The founder is the owner of the official server (resolved at API
-- startup). Founder-only endpoints (plan changes, quota reads) write
-- an append-only row here so every privileged action is traceable.
--
-- Written by the Rust API only (over service_role). RLS is
-- defense-in-depth (ADR-040): no client policy → clients cannot read
-- or write. Idempotent + non-destructive (ADR-019).
-- =============================================================

CREATE TABLE IF NOT EXISTS public.platform_admin_audit (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- The founder who performed the action. Nullable so ON DELETE SET NULL can
    -- preserve this append-only row if the actor's profile is ever deleted
    -- (a NOT NULL column would abort the cascading delete instead).
    actor_id       UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    -- Machine action key, e.g. 'user_plan_set'. Constrained by the Rust caller.
    action         TEXT NOT NULL CHECK (char_length(action) <= 64),
    -- The user the action targeted (NULL for non-user-scoped actions).
    target_user_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
    -- Action-specific extras, e.g. {"fromPlan":"free","toPlan":"supporter"}.
    detail         JSONB NOT NULL DEFAULT '{}'::jsonb
                     CHECK (jsonb_typeof(detail) = 'object'),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Newest-first listing per actor (cursor pagination, ADR-036).
CREATE INDEX IF NOT EXISTS idx_platform_admin_audit_created
    ON public.platform_admin_audit (created_at DESC, id DESC);

ALTER TABLE public.platform_admin_audit ENABLE ROW LEVEL SECURITY;

-- No SELECT/INSERT/UPDATE/DELETE policy → clients are fully locked out.
-- The Rust API writes over the service_role connection, which bypasses RLS.
