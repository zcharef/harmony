-- Voice mute/deafen state: persisted so other participants can see it via SSE.

ALTER TABLE voice_sessions
ADD COLUMN IF NOT EXISTS is_muted BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE voice_sessions
ADD COLUMN IF NOT EXISTS is_deafened BOOLEAN NOT NULL DEFAULT false;
