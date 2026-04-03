-- System moderator sentinel profile for FK references (e.g. messages.deleted_by)
-- and per-server moderation category overrides.

-- 1. Insert sentinel auth.users row (FK target for profiles.id).
--    The on_auth_user_created trigger will auto-create a profiles row.
INSERT INTO auth.users (id, role, email, encrypted_password, created_at, updated_at)
SELECT
    '00000000-0000-0000-0000-000000000001',
    'authenticated',
    'system@harmony.internal',
    '$2a$10$SYSTEM_MODERATOR_NO_LOGIN_EVER',
    now(),
    now()
WHERE NOT EXISTS (
    SELECT 1 FROM auth.users WHERE id = '00000000-0000-0000-0000-000000000001'
);

-- 1b. Fix role for existing deployments where the sentinel was already created
--     with 'service_role'. Also set an invalid bcrypt hash to block any login.
UPDATE auth.users
SET role               = 'authenticated',
    encrypted_password = '$2a$10$SYSTEM_MODERATOR_NO_LOGIN_EVER'
WHERE id   = '00000000-0000-0000-0000-000000000001'
  AND role = 'service_role';

-- 2. Fix profile created by trigger: set canonical username and display name.
--    username = '_system_' satisfies CHECK ^[a-z0-9_]{3,32}$
--    display_name = '[system]' is the human-visible label
UPDATE public.profiles
SET username     = '_system_',
    display_name = '[system]'
WHERE id = '00000000-0000-0000-0000-000000000001'
  AND username <> '_system_';

-- 3. Add moderation_categories JSONB column to servers.
ALTER TABLE public.servers
    ADD COLUMN IF NOT EXISTS moderation_categories JSONB NOT NULL DEFAULT '{}'::JSONB;

-- 4. CHECK: value must be a JSON object (not array, string, etc.)
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.servers'::regclass
          AND conname = 'servers_moderation_categories_is_object'
    ) THEN
        ALTER TABLE public.servers
            ADD CONSTRAINT servers_moderation_categories_is_object
            CHECK (jsonb_typeof(moderation_categories) = 'object');
    END IF;
END $$;

-- 5. CHECK: Tier 1 categories (always blocked) cannot be overridden.
DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.servers'::regclass
          AND conname = 'servers_moderation_categories_no_tier1'
    ) THEN
        ALTER TABLE public.servers
            ADD CONSTRAINT servers_moderation_categories_no_tier1
            CHECK (NOT moderation_categories ?| ARRAY[
                'self-harm/instructions',
                'self-harm/intent',
                'sexual/minors',
                'violence/graphic'
            ]);
    END IF;
END $$;

-- 6. Column comment.
COMMENT ON COLUMN public.servers.moderation_categories IS
    'Per-server moderation category overrides. Keys are OpenAI category slugs, '
    'values are objects like {"enabled": false}. Tier 1 categories '
    '(self-harm/instructions, self-harm/intent, sexual/minors, violence/graphic) '
    'cannot be overridden — enforced by CHECK constraint.';
