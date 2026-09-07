-- Additive source foundation only. Existing routes continue using legacy storage.
-- No legacy ownership is inferred and no objects are copied or deleted here.
CREATE TABLE kb_file_lifecycle (
  project TEXT NOT NULL,
  file_id TEXT NOT NULL,
  domain TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  storage_version INTEGER NOT NULL CHECK (storage_version IN (1, 2)),
  state TEXT NOT NULL CHECK (state IN ('uploading', 'active', 'deleting', 'deleted')),
  generation INTEGER NOT NULL CHECK (generation > 0),
  published_generation INTEGER,
  active_operation_id TEXT,
  deletion_id TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (project, file_id)
);
-- Tombstones deliberately do not cascade with kb_files.
CREATE TABLE kb_file_operations (
  operation_id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  file_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('upload', 'ingest', 'reprocess', 'copy')),
  state TEXT NOT NULL CHECK (state IN ('running', 'settled')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  settled_at TEXT,
  UNIQUE (operation_id, project, file_id, generation),
  FOREIGN KEY (project, file_id) REFERENCES kb_file_lifecycle(project, file_id)
);
CREATE INDEX idx_kb_file_operations_owner ON kb_file_operations(project, file_id, state);
CREATE TABLE kb_file_artifacts (
  artifact_id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  file_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  operation_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('raw', 'parse', 'document', 'vector')),
  resource_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  write_state TEXT NOT NULL DEFAULT 'intent' CHECK (write_state IN ('intent', 'accepted', 'confirmed')),
  cleanup_state TEXT NOT NULL DEFAULT 'pending' CHECK (cleanup_state IN ('pending', 'confirmed')),
  mutation_receipt TEXT,
  UNIQUE (provider, resource_id),
  FOREIGN KEY (operation_id, project, file_id, generation)
    REFERENCES kb_file_operations(operation_id, project, file_id, generation)
);
CREATE INDEX idx_kb_file_artifacts_cleanup ON kb_file_artifacts(project, file_id, cleanup_state);
CREATE TABLE kb_file_parse_artifacts (
  project TEXT NOT NULL,
  file_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  artifact_id TEXT NOT NULL UNIQUE REFERENCES kb_file_artifacts(artifact_id),
  content_hash TEXT NOT NULL,
  parser TEXT NOT NULL,
  parser_version TEXT,
  page_count INTEGER,
  PRIMARY KEY (project, file_id, generation),
  FOREIGN KEY (project, file_id) REFERENCES kb_file_lifecycle(project, file_id)
);
CREATE INDEX idx_kb_file_parse_hash ON kb_file_parse_artifacts(project, content_hash);
