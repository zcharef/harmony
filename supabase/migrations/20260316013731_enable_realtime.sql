-- =============================================================
-- Migration: enable_realtime
-- Enables Supabase Realtime on the messages table
-- =============================================================

-- Add messages table to the supabase_realtime publication
-- so clients can subscribe to INSERT/UPDATE/DELETE events
ALTER PUBLICATION supabase_realtime ADD TABLE public.messages;
