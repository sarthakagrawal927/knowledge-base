-- Inactive protocol integration: transactional publication and durable visibility.
CREATE TABLE kb_scope_revisions (
  project TEXT NOT NULL,
  domain TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project, domain)
);
CREATE TABLE kb_file_publications (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  operation_id TEXT NOT NULL UNIQUE,
  project TEXT NOT NULL,
  file_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (operation_id, project, file_id, generation) REFERENCES kb_file_operations(operation_id, project, file_id, generation)
);
CREATE TRIGGER kb_file_publication_guard BEFORE INSERT ON kb_file_publications
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM kb_file_operations o JOIN kb_file_lifecycle l
      ON l.project = o.project AND l.file_id = o.file_id
    WHERE o.operation_id = NEW.operation_id AND o.state = 'running'
      AND l.state IN ('uploading', 'active') AND l.generation = o.generation
      AND l.active_operation_id = o.operation_id
      AND NOT EXISTS (SELECT 1 FROM kb_file_artifacts a WHERE a.operation_id = o.operation_id AND a.write_state = 'intent')
  ) THEN RAISE(ABORT, 'file_operation_not_publishable') END;
END;
CREATE TRIGGER kb_file_visibility_revision AFTER UPDATE OF state, published_generation ON kb_file_lifecycle
WHEN OLD.state != NEW.state OR OLD.published_generation IS NOT NEW.published_generation
BEGIN
  INSERT INTO kb_scope_revisions(project, domain, revision) VALUES (NEW.project, NEW.domain, 1)
  ON CONFLICT(project, domain) DO UPDATE SET revision = revision + 1;
END;
CREATE VIEW kb_visible_files AS
SELECT f.* FROM kb_files f LEFT JOIN kb_file_lifecycle l ON l.project = f.project AND l.file_id = f.id
WHERE l.file_id IS NULL OR l.state IN ('uploading', 'active');
CREATE VIEW kb_visible_documents AS
SELECT d.* FROM documents d LEFT JOIN kb_file_lifecycle l
  ON l.project = d.tenant AND l.file_id = json_extract(d.metadata, '$.file_id')
WHERE l.file_id IS NULL OR (l.state = 'active' AND l.published_generation = json_extract(d.metadata, '$.file_generation'));
CREATE VIEW kb_visible_chunks AS
SELECT c.* FROM chunks c LEFT JOIN kb_file_lifecycle l
  ON l.project = c.tenant AND l.file_id = json_extract(c.metadata, '$.file_id')
WHERE l.file_id IS NULL OR (l.state = 'active' AND l.published_generation = json_extract(c.metadata, '$.file_generation'));
CREATE TABLE kb_owned_entity_identities (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  domain TEXT NOT NULL,
  type TEXT NOT NULL,
  identity_key TEXT NOT NULL,
  UNIQUE(project, domain, type, identity_key)
);
CREATE TABLE kb_owned_entity_facts (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  domain TEXT NOT NULL,
  file_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  operation_id TEXT NOT NULL REFERENCES kb_file_operations(operation_id),
  entity_id TEXT NOT NULL REFERENCES kb_owned_entity_identities(id),
  schema_id TEXT NOT NULL,
  display_name TEXT,
  fields TEXT NOT NULL,
  record_index INTEGER NOT NULL DEFAULT 0,
  is_primary INTEGER NOT NULL DEFAULT 1,
  evidence_chunk_id TEXT,
  evidence_text TEXT,
  confidence REAL NOT NULL DEFAULT 0.95,
  UNIQUE(project, file_id, generation, entity_id, schema_id)
);
CREATE INDEX idx_kb_owned_entity_facts_file ON kb_owned_entity_facts(project, file_id, generation);
CREATE TABLE kb_owned_relationship_facts (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  domain TEXT NOT NULL,
  file_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  operation_id TEXT NOT NULL REFERENCES kb_file_operations(operation_id),
  rel_type TEXT NOT NULL,
  src_id TEXT NOT NULL,
  dst_id TEXT NOT NULL,
  evidence_page INTEGER NOT NULL DEFAULT 1,
  UNIQUE(project, file_id, generation, rel_type, src_id, dst_id)
);
CREATE INDEX idx_kb_owned_relationship_facts_file ON kb_owned_relationship_facts(project, file_id, generation);
CREATE VIEW kb_visible_entity_facts AS
SELECT f.*, p.sequence, p.created_at AS published_at FROM kb_owned_entity_facts f
JOIN kb_file_lifecycle l ON l.project = f.project AND l.file_id = f.file_id
JOIN kb_file_publications p ON p.operation_id = f.operation_id
WHERE l.state = 'active' AND l.published_generation = f.generation;
CREATE VIEW kb_visible_relationship_facts AS
SELECT f.*, p.sequence, p.created_at AS published_at FROM kb_owned_relationship_facts f
JOIN kb_file_lifecycle l ON l.project = f.project AND l.file_id = f.file_id
JOIN kb_file_publications p ON p.operation_id = f.operation_id
WHERE l.state = 'active' AND l.published_generation = f.generation;
CREATE VIEW kb_visible_entities AS
WITH ranked AS (
  SELECT f.*, ROW_NUMBER() OVER (PARTITION BY f.entity_id ORDER BY f.sequence DESC, f.id DESC) AS rank
  FROM kb_visible_entity_facts f
), owned AS (
  SELECT i.id, i.project, i.domain, i.type, i.identity_key, f.display_name, f.fields,
    (SELECT r.dst_id FROM kb_visible_relationship_facts r WHERE r.project = i.project AND r.src_id = i.id AND r.rel_type = 'parent'
     ORDER BY r.sequence DESC, r.id DESC LIMIT 1) AS parent_id,
    f.published_at AS created_at, f.published_at AS updated_at, f.file_id, f.generation AS file_generation,
    (SELECT filename FROM kb_files WHERE id = f.file_id AND project = f.project) AS filename, f.evidence_chunk_id, f.evidence_text
  FROM ranked f JOIN kb_owned_entity_identities i ON i.id = f.entity_id WHERE f.rank = 1
)
SELECT * FROM owned
UNION ALL
SELECT e.*, NULL AS file_id, NULL AS file_generation, NULL AS filename, NULL AS evidence_chunk_id, NULL AS evidence_text FROM kb_entities e WHERE NOT EXISTS (SELECT 1 FROM owned o WHERE o.project = e.project AND o.domain = e.domain AND o.type = e.type AND o.identity_key = e.identity_key);
CREATE VIEW kb_visible_relationships AS
WITH ranked AS (
  SELECT f.*, ROW_NUMBER() OVER (PARTITION BY f.project, f.domain, f.rel_type, f.src_id, f.dst_id ORDER BY f.sequence DESC, f.id DESC) AS rank
  FROM kb_visible_relationship_facts f
), owned AS (
  SELECT id, project, domain, rel_type, src_id, dst_id, file_id AS evidence_file, evidence_page, published_at AS created_at
  FROM ranked WHERE rank = 1
)
SELECT * FROM owned
UNION ALL
SELECT r.* FROM kb_entity_relationships r WHERE NOT EXISTS (
  SELECT 1 FROM owned o WHERE o.project = r.project AND o.domain = r.domain AND o.rel_type = r.rel_type AND o.src_id = r.src_id AND o.dst_id = r.dst_id
);

CREATE VIEW kb_visible_entity_mentions AS
SELECT m.* FROM kb_entity_mentions m
UNION ALL
SELECT id, project, domain, entity_id, file_id, schema_id, fields AS field_values, confidence, published_at AS created_at
FROM kb_visible_entity_facts;

CREATE TABLE kb_owned_provenance_spans (
  id TEXT PRIMARY KEY,
  project TEXT NOT NULL,
  domain TEXT NOT NULL,
  file_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  operation_id TEXT NOT NULL REFERENCES kb_file_operations(operation_id),
  entity_id TEXT NOT NULL,
  field TEXT NOT NULL,
  page_start INTEGER NOT NULL,
  page_end INTEGER NOT NULL,
  excerpt TEXT NOT NULL,
  UNIQUE(project,file_id,generation,entity_id,field,excerpt)
);
CREATE INDEX idx_kb_owned_provenance_file ON kb_owned_provenance_spans(project,file_id,generation);
CREATE VIEW kb_visible_kb_chunks AS
SELECT c.rowid AS rowid,c.id,c.project,c.domain,c.file_id,
  COALESCE(c.entity_id, (SELECT f.entity_id FROM kb_visible_entity_facts f
    WHERE f.project=c.project AND f.file_id=c.file_id AND f.is_primary=1
      AND (f.evidence_chunk_id=c.vector_id OR f.record_index=json_extract(c.metadata,'$.record_index')) LIMIT 1)) AS entity_id,
  c.parent_chunk,c.vector_id,c.page_start,c.page_end,c.text,c.content_hash,c.also_in_files,c.bbox,c.metadata,c.created_at
FROM kb_chunks c LEFT JOIN kb_file_lifecycle l ON l.project=c.project AND l.file_id=c.file_id
WHERE l.file_id IS NULL OR (l.state='active' AND l.published_generation=json_extract(c.metadata,'$.file_generation'));
