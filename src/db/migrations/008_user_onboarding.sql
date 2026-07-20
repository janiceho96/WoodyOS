ALTER TABLE users
  ADD COLUMN onboarding_completed BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN onboarding_version INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN onboarding_last_step SMALLINT NOT NULL DEFAULT 1 CHECK (onboarding_last_step BETWEEN 1 AND 6),
  ADD COLUMN onboarding_completed_at TIMESTAMPTZ,
  ADD COLUMN onboarding_skipped_at TIMESTAMPTZ;
