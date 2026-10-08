CREATE TABLE learning_attempts_v1 (
  user_id text NOT NULL,
  library_id text NOT NULL,
  attempt_id text NOT NULL,
  group_id text NOT NULL,
  revision integer NOT NULL,
  attempt_json text NOT NULL,
  formal_event_id text,
  formal_logical_key text,
  updated_at text NOT NULL,
  PRIMARY KEY (user_id, library_id, attempt_id),
  FOREIGN KEY (user_id, library_id) REFERENCES account_study_libraries(user_id, library_id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX learning_attempts_v1_formal_uq ON learning_attempts_v1(user_id, library_id, formal_event_id);
--> statement-breakpoint
CREATE UNIQUE INDEX learning_attempts_v1_logical_uq ON learning_attempts_v1(user_id, library_id, formal_logical_key);
--> statement-breakpoint
CREATE INDEX learning_attempts_v1_group_idx ON learning_attempts_v1(user_id, library_id, group_id, updated_at);
