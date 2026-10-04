CREATE TABLE materials (
  id uuid PRIMARY KEY,
  user_id text NOT NULL REFERENCES "user" (id),
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  kind text NOT NULL CHECK (kind IN ('PDF', 'Notes')),
  notes text,
  object_key text UNIQUE,
  byte_size bigint NOT NULL DEFAULT 0 CHECK (byte_size BETWEEN 0 AND 20971520),
  state text NOT NULL CHECK (state IN ('uploading', 'ready', 'deleting')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  cleanup_attempts integer NOT NULL DEFAULT 0,
  CHECK ((kind = 'Notes' AND notes IS NOT NULL AND char_length(notes) BETWEEN 1 AND 100000 AND object_key IS NULL AND byte_size = 0)
    OR (kind = 'PDF' AND notes IS NULL AND object_key IS NOT NULL AND byte_size > 0))
);
CREATE INDEX materials_owner_created ON materials (user_id, created_at DESC);
CREATE INDEX materials_cleanup ON materials (state, updated_at) WHERE state <> 'ready';
CREATE TABLE material_rate_limits (
  user_id text PRIMARY KEY REFERENCES "user" (id) ON DELETE CASCADE,
  window_start timestamptz NOT NULL,
  attempts integer NOT NULL
);
UPDATE user_preferences SET preferences = preferences - 'subject' WHERE preferences ? 'subject';
