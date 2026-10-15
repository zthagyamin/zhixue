CREATE TABLE paper_reading_workspaces_v1 (
  user_id text NOT NULL,
  library_id text NOT NULL,
  unit_id text NOT NULL,
  revision integer NOT NULL,
  workspace_json text NOT NULL,
  PRIMARY KEY (user_id, library_id, unit_id),
  FOREIGN KEY (user_id, library_id) REFERENCES account_study_libraries(user_id, library_id) ON DELETE CASCADE
);
