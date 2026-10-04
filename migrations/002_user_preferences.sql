CREATE TABLE user_preferences (
  user_id text PRIMARY KEY REFERENCES "user" (id) ON DELETE CASCADE,
  preferences jsonb NOT NULL,
  onboarding_completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
