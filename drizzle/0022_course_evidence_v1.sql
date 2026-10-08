CREATE TABLE course_evidence_v1 (
  user_id text NOT NULL,
  library_id text NOT NULL,
  attempt_id text NOT NULL,
  revision integer NOT NULL,
  evidence_json text NOT NULL,
  updated_at text NOT NULL,
  PRIMARY KEY (user_id, library_id, attempt_id),
  FOREIGN KEY (user_id, library_id) REFERENCES account_study_libraries(user_id, library_id) ON DELETE CASCADE
);
