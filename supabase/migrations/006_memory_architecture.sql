-- Memory architecture — item 16.5
-- Adds the longitudinal tier (observed behavior across shifts) as a sibling
-- to robin_preferences (stated intent). See /docs/memory-architecture.md.
--
-- Preferences vs. longitudinal:
--   robin_preferences    = what the physician stated at onboarding (intent)
--   robin_longitudinal   = what Robin has observed across shifts (behavior)
--
-- The columns never silently override each other. Reconciliation happens
-- at physician-chosen moments (shift close, settings) via the
-- pending_observations array inside robin_longitudinal.

alter table public.physicians
  add column if not exists robin_longitudinal jsonb default '{}';

-- Note on shifts.summary (defined in 001_initial_schema.sql): the column
-- has zero writers and zero readers in production and is deprecated. It is
-- NOT dropped here — leaving the column costs nothing and a future structured
-- shift-close summary could revive it. All shift-level memory writes go to
-- shifts.robin_memory (see migration 003_robin_chat.sql).
