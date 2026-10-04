ALTER TABLE study_sessions DROP CONSTRAINT study_sessions_kind_check;
ALTER TABLE study_sessions ADD CONSTRAINT study_sessions_kind_check CHECK(kind IN ('study','practice','voice'));
ALTER TABLE study_sessions DROP CONSTRAINT study_sessions_mode_check;
ALTER TABLE study_sessions ADD CONSTRAINT study_sessions_mode_check CHECK(mode IN ('Explain','Quiz','Explain It Back','Practice','Classmate','Mock Examiner'));
CREATE TABLE voice_sessions (
 id uuid PRIMARY KEY REFERENCES study_sessions(id) ON DELETE CASCADE,
 user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
 material_id uuid NOT NULL REFERENCES material_ai(material_id) ON DELETE CASCADE,
 alias uuid NOT NULL UNIQUE,
 capability_hash text NOT NULL,
 auth_session_id text NOT NULL,
 provider_id text UNIQUE,
 status text NOT NULL CHECK(status IN ('starting','active','ending','ended','failed','uncertain')),
 consent_at timestamptz NOT NULL DEFAULT now(),
 created_at timestamptz NOT NULL DEFAULT now(),
 expires_at timestamptz NOT NULL DEFAULT now()+interval '10 minutes',
 connected_at timestamptz,
 ended_at timestamptz,
 preferences jsonb NOT NULL,
 transcript jsonb NOT NULL DEFAULT '[]',
 transcript_final boolean NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX voice_active_owner ON voice_sessions(user_id) WHERE status IN ('starting','active','uncertain');
CREATE UNIQUE INDEX voice_active_material ON voice_sessions(material_id) WHERE status IN ('starting','active','uncertain');
CREATE TABLE voice_starts (
 id uuid PRIMARY KEY,
 user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX voice_starts_owner ON voice_starts(user_id,created_at);
CREATE TABLE voice_turns (
 session_id uuid NOT NULL REFERENCES voice_sessions(id) ON DELETE CASCADE,
 position integer NOT NULL,
 request_key uuid NOT NULL UNIQUE,
 content_hash text NOT NULL,
 response text NOT NULL DEFAULT '',
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','completed','interrupted','failed')),
 PRIMARY KEY(session_id,position)
);
CREATE TABLE voice_webhook_receipts (
 digest text PRIMARY KEY,
 received_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE voice_cleanup (
 alias uuid PRIMARY KEY,
 provider_id text,
 attempts integer NOT NULL DEFAULT 0,
 not_before timestamptz NOT NULL DEFAULT now()+interval '20 minutes'
);
CREATE FUNCTION queue_voice_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO study_partner.voice_cleanup(alias,provider_id) VALUES(OLD.alias,OLD.provider_id) ON CONFLICT DO NOTHING;
 RETURN OLD;
END $$;
CREATE TRIGGER voice_remote_cleanup BEFORE DELETE ON voice_sessions FOR EACH ROW EXECUTE FUNCTION queue_voice_cleanup();
