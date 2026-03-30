-- =============================================================
-- Migration: v4_pricing_update
-- WHY: V4 pricing — gate on real costs (voice/storage).
-- Members and channels are now effectively unlimited on all tiers.
-- Free: 500 members, unlimited channels.
-- Supporter/Creator: unlimited members + channels.
-- Hard limits enforced at API layer (plan.rs), not DB.
-- =============================================================

-- No schema changes needed.
-- Plan limits are enforced at the Rust API layer via PlanLimits constants.
-- This migration is a no-op to document the pricing change in the migration history.

COMMENT ON COLUMN public.servers.plan IS
  'V4 pricing tiers: free (500 members, unlimited channels),
   supporter (unlimited members/channels, 50GB storage, 100 voice),
   creator (unlimited members/channels, 200GB storage, 500 voice, vanity URL).
   Voice and storage limits enforced in application layer when those features ship.';
