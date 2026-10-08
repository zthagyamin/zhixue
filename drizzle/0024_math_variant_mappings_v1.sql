CREATE TABLE math_variant_mappings_v1 (
  schema_version integer NOT NULL CHECK (schema_version = 1),
  user_id text NOT NULL,
  library_id text NOT NULL,
  snapshot_id text NOT NULL,
  item_key text NOT NULL,
  content_hash text NOT NULL,
  mapping_id text NOT NULL,
  record_json text NOT NULL,
  origin_grant_id text NOT NULL,
  published_at text NOT NULL,
  PRIMARY KEY (user_id, library_id, snapshot_id, item_key, content_hash, mapping_id),
  FOREIGN KEY (user_id, library_id) REFERENCES account_study_libraries(user_id, library_id),
  FOREIGN KEY (origin_grant_id) REFERENCES account_study_grants(grant_id)
);
