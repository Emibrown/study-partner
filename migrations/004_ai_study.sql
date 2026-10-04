CREATE TABLE material_ai (
 material_id uuid PRIMARY KEY REFERENCES materials(id) ON DELETE CASCADE,
 consent_at timestamptz NOT NULL DEFAULT now(),
 context_id uuid NOT NULL UNIQUE,
 assistant_id text,
 document_id text,
 status text NOT NULL CHECK (status IN ('preparing','indexing','ready','failed','uncertain')),
 lease_until timestamptz NOT NULL DEFAULT now() + interval '5 minutes'
);
CREATE TABLE study_sessions (
 id uuid PRIMARY KEY,
 material_id uuid NOT NULL REFERENCES material_ai(material_id) ON DELETE CASCADE,
 kind text NOT NULL CHECK(kind IN ('study','practice')),
 mode text NOT NULL CHECK(mode IN ('Explain','Quiz','Explain It Back','Practice')),
 thread_id text,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE study_messages (
 id uuid PRIMARY KEY,
 session_id uuid NOT NULL REFERENCES study_sessions(id) ON DELETE CASCADE,
 role text NOT NULL CHECK(role IN ('user','assistant','mode')),
 content text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE ai_operations (
 id uuid PRIMARY KEY,
 user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
 material_id uuid NOT NULL REFERENCES material_ai(material_id) ON DELETE CASCADE,
 session_id uuid NOT NULL REFERENCES study_sessions(id) ON DELETE CASCADE,
 request_key uuid NOT NULL,
 fingerprint text NOT NULL,
 status text NOT NULL CHECK(status IN ('running','uncertain','completed','failed','cancelled')),
 run_id text,
 provider_message_id text,
 baseline_ids jsonb NOT NULL DEFAULT '[]',
 output text NOT NULL DEFAULT '',
 cancel_requested boolean NOT NULL DEFAULT false,
 dispatched boolean NOT NULL DEFAULT false,
 lease_until timestamptz NOT NULL DEFAULT now() + interval '5 minutes',
 created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(user_id,request_key)
);
CREATE UNIQUE INDEX ai_one_active_material ON ai_operations(material_id) WHERE status IN ('running','uncertain');
CREATE INDEX ai_operations_session ON ai_operations(session_id,created_at);
CREATE TABLE ai_usage (
 id uuid PRIMARY KEY,
 user_id text NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ai_usage_owner_time ON ai_usage(user_id,created_at);
CREATE TABLE practice_questions (
 session_id uuid NOT NULL REFERENCES study_sessions(id) ON DELETE CASCADE,
 position integer NOT NULL CHECK(position BETWEEN 0 AND 4),
 question text NOT NULL,
 choices jsonb NOT NULL,
 correct integer NOT NULL CHECK(correct BETWEEN 0 AND 3),
 explanation text NOT NULL,
 topic text NOT NULL,
 evidence text NOT NULL,
 answer integer CHECK(answer BETWEEN 0 AND 3),
 answered_at timestamptz,
 PRIMARY KEY(session_id,position)
);
CREATE TABLE ai_cleanup (
 context_id uuid PRIMARY KEY,
 assistant_id text,
 attempts integer NOT NULL DEFAULT 0,
 not_before timestamptz NOT NULL DEFAULT now() + interval '10 minutes'
);
CREATE FUNCTION queue_ai_cleanup() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO study_partner.ai_cleanup(context_id,assistant_id) VALUES(OLD.context_id,OLD.assistant_id) ON CONFLICT DO NOTHING;
 RETURN OLD;
END $$;
CREATE TRIGGER ai_context_cleanup BEFORE DELETE ON material_ai FOR EACH ROW EXECUTE FUNCTION queue_ai_cleanup();
CREATE FUNCTION block_deleted_material_ai() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.state = 'deleting' AND OLD.state <> 'deleting' THEN
  DELETE FROM study_partner.material_ai WHERE material_id = NEW.id;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER material_ai_block AFTER UPDATE OF state ON materials FOR EACH ROW EXECUTE FUNCTION block_deleted_material_ai();
