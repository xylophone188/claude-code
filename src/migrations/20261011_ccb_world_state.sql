-- Migration: Create ccb_world_state table
CREATE TABLE IF NOT EXISTS omniroute.ccb_world_state (
  node_id TEXT PRIMARY KEY,
  probed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status TEXT NOT NULL DEFAULT 'active',
  cpu JSONB NOT NULL DEFAULT '{}'::jsonb,
  mem JSONB NOT NULL DEFAULT '{}'::jsonb,
  gpu JSONB NOT NULL DEFAULT '[]'::jsonb,
  network_latency DOUBLE PRECISION NOT NULL DEFAULT 0.0,
  health TEXT NOT NULL DEFAULT 'healthy',
  capabilities JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ccb_world_state_probed_at ON omniroute.ccb_world_state (probed_at);
CREATE INDEX IF NOT EXISTS idx_ccb_world_state_health ON omniroute.ccb_world_state (health);

CREATE OR REPLACE VIEW public.ccb_world_state AS 
  SELECT * FROM omniroute.ccb_world_state;
