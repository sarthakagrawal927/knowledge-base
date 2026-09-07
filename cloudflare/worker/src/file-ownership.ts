import type { RegisterFileInput } from './kb-metadata-repository';

// Internal foundation, intentionally not wired to product routes until every
// supported writer and retrieval/cache path participates in this protocol.
export interface FileLifecycle {
  project: string;
  file_id: string;
  domain: string;
  content_hash: string;
  storage_version: number;
  state: 'uploading' | 'active' | 'deleting' | 'deleted';
  generation: number;
  published_generation: number | null;
  active_operation_id: string | null;
  deletion_id: string | null;
}

export interface FileOperation {
  operation_id: string;
  project: string;
  file_id: string;
  generation: number;
  kind: 'upload' | 'ingest' | 'reprocess' | 'copy';
  state: 'running' | 'settled';
}

export interface FileArtifact {
  artifact_id: string;
  project: string;
  file_id: string;
  generation: number;
  operation_id: string;
  kind: 'raw' | 'parse' | 'document' | 'vector';
  resource_id: string;
  provider: string;
  write_state: 'intent' | 'accepted' | 'confirmed';
  cleanup_state: 'pending' | 'confirmed';
  mutation_receipt: string | null;
}

export function ownedRawKey(project: string, fileId: string, contentHash: string): string {
  return `raw/v2/${encodeURIComponent(project)}/${encodeURIComponent(fileId)}/${encodeURIComponent(contentHash)}`;
}

export function ownedParseKey(operation: FileOperation): string {
  return `parse/v2/${encodeURIComponent(operation.project)}/${encodeURIComponent(operation.file_id)}/${operation.generation}/${encodeURIComponent(operation.operation_id)}.json`;
}

export class D1FileOwnership {
  constructor(private readonly db: D1Database) {}

  async get(project: string, fileId: string): Promise<FileLifecycle | null> {
    return await this.db.prepare('SELECT * FROM kb_file_lifecycle WHERE project = ? AND file_id = ?').bind(project, fileId).first<FileLifecycle>();
  }

  async operation(project: string, operationId: string): Promise<FileOperation | null> {
    return await this.db.prepare('SELECT * FROM kb_file_operations WHERE project = ? AND operation_id = ?').bind(project, operationId).first<FileOperation>();
  }

  // Caller must ensure the domain exists. Registration never rewrites a winning
  // duplicate's key or silently converts a legacy file to owned storage.
  async reserve(input: Omit<RegisterFileInput, 'objectKey'>, operationId: string): Promise<FileLifecycle | null> {
    const key = ownedRawKey(input.project, input.id, input.contentHash);
    await this.db.batch([
      this.db
        .prepare(`INSERT INTO kb_files (id, project, domain, filename, mime, bytes, content_hash, canonical_hash, object_key)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(project, domain, content_hash) DO NOTHING`)
        .bind(input.id, input.project, input.domain, input.filename, input.mime, input.bytes, input.contentHash, input.canonicalHash ?? null, key),
      this.db
        .prepare(`INSERT INTO kb_file_lifecycle
        (project, file_id, domain, content_hash, storage_version, state, generation, active_operation_id)
        SELECT project, id, domain, content_hash, 2, 'uploading', 1, ? FROM kb_files
        WHERE project = ? AND id = ? AND object_key = ?
        ON CONFLICT(project, file_id) DO NOTHING`)
        .bind(operationId, input.project, input.id, key),
      this.db
        .prepare(`INSERT INTO kb_file_operations (operation_id, project, file_id, generation, kind, state)
        SELECT ?, project, file_id, generation, 'upload', 'running' FROM kb_file_lifecycle
        WHERE project = ? AND file_id = ? AND active_operation_id = ?
        AND NOT EXISTS (SELECT 1 FROM kb_file_operations WHERE operation_id = ? AND project = ? AND file_id = ?)`)
        .bind(operationId, input.project, input.id, operationId, operationId, input.project, input.id),
    ]);
    return await this.db
      .prepare(`SELECT l.* FROM kb_file_lifecycle l JOIN kb_files f ON f.id = l.file_id AND f.project = l.project
      WHERE f.project = ? AND f.domain = ? AND f.content_hash = ?`)
      .bind(input.project, input.domain, input.contentHash)
      .first<FileLifecycle>();
  }

  async claim(project: string, fileId: string, operationId: string, kind: 'ingest' | 'reprocess' | 'copy'): Promise<FileOperation | null> {
    const results = await this.db.batch([
      this.db
        .prepare(`UPDATE kb_file_lifecycle SET active_operation_id = ?, generation = generation + 1, updated_at = datetime('now')
        WHERE project = ? AND file_id = ? AND state = 'active' AND active_operation_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM kb_file_operations WHERE operation_id = ?)`)
        .bind(operationId, project, fileId, operationId),
      this.db
        .prepare(`INSERT INTO kb_file_operations (operation_id, project, file_id, generation, kind, state)
        SELECT ?, project, file_id, generation, ?, 'running' FROM kb_file_lifecycle
        WHERE project = ? AND file_id = ? AND active_operation_id = ?
        ON CONFLICT(operation_id) DO NOTHING`)
        .bind(operationId, kind, project, fileId, operationId),
    ]);
    return results[0]?.meta.changes ? await this.operation(project, operationId) : null;
  }

  // An intent is durable before any external call. A delete wins against any
  // not-yet-recorded work; already-recorded work remains tracked until settled.
  async recordIntent(operation: FileOperation, artifact: Pick<FileArtifact, 'artifact_id' | 'kind' | 'resource_id' | 'provider'>): Promise<boolean> {
    const result = await this.db
      .prepare(`INSERT INTO kb_file_artifacts
      (artifact_id, project, file_id, generation, operation_id, kind, resource_id, provider)
      SELECT ?, o.project, o.file_id, o.generation, o.operation_id, ?, ?, ?
      FROM kb_file_operations o JOIN kb_file_lifecycle l ON l.project = o.project AND l.file_id = o.file_id
      WHERE o.project = ? AND o.operation_id = ? AND o.state = 'running'
      AND l.state IN ('uploading', 'active') AND l.generation = o.generation AND l.active_operation_id = o.operation_id`)
      .bind(artifact.artifact_id, artifact.kind, artifact.resource_id, artifact.provider, operation.project, operation.operation_id)
      .run();
    return result.meta.changes === 1;
  }

  async recordWrite(
    project: string,
    operationId: string,
    artifactId: string,
    state: 'accepted' | 'confirmed',
    receipt: string | null = null,
  ): Promise<boolean> {
    const result = await this.db
      .prepare(`UPDATE kb_file_artifacts SET write_state = ?, mutation_receipt = ?
      WHERE project = ? AND operation_id = ? AND artifact_id = ? AND cleanup_state = 'pending'
      AND EXISTS (SELECT 1 FROM kb_file_operations o WHERE o.operation_id = kb_file_artifacts.operation_id AND o.state = 'running')`)
      .bind(state, receipt, project, operationId, artifactId)
      .run();
    return result.meta.changes === 1;
  }

  // Call only after all external calls have returned. The SQL guard makes
  // metadata statements and publication one transaction, rejecting stale work.
  async publish(operation: FileOperation, statements: D1PreparedStatement[] = []): Promise<boolean> {
    try {
      await this.db.batch([
        this.db
          .prepare('INSERT INTO kb_file_publications(operation_id, project, file_id, generation) VALUES (?, ?, ?, ?)')
          .bind(operation.operation_id, operation.project, operation.file_id, operation.generation),
        ...statements,
        this.db
          .prepare(`UPDATE kb_file_lifecycle SET state = 'active', published_generation = generation, updated_at = datetime('now')
          WHERE project = ? AND file_id = ? AND generation = ? AND active_operation_id = ?`)
          .bind(operation.project, operation.file_id, operation.generation, operation.operation_id),
        ...this.settlementStatements(operation),
      ]);
      return true;
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes('file_operation_not_publishable')) throw error;
      await this.settle(operation, false);
      return false;
    }
  }

  private settlementStatements(operation: FileOperation): D1PreparedStatement[] {
    return [
      this.db
        .prepare(`UPDATE kb_file_operations SET state = 'settled', settled_at = datetime('now')
        WHERE project = ? AND operation_id = ? AND state = 'running'`)
        .bind(operation.project, operation.operation_id),
      this.db
        .prepare(`UPDATE kb_file_lifecycle SET active_operation_id = NULL, updated_at = datetime('now')
        WHERE project = ? AND file_id = ? AND active_operation_id = ?`)
        .bind(operation.project, operation.file_id, operation.operation_id),
    ];
  }

  async settle(operation: FileOperation, publish: boolean): Promise<boolean> {
    if (publish) return await this.publish(operation);
    await this.db.batch(this.settlementStatements(operation));
    return false;
  }

  async scopeRevision(project: string, domain: string): Promise<number> {
    const row = await this.db
      .prepare('SELECT revision FROM kb_scope_revisions WHERE project = ? AND domain = ?')
      .bind(project, domain)
      .first<{ revision: number }>();
    return row?.revision ?? 0;
  }

  async requestDelete(project: string, fileId: string, deletionId: string): Promise<FileLifecycle | null> {
    await this.db
      .prepare(`UPDATE kb_file_lifecycle SET state = 'deleting', generation = generation + 1,
      published_generation = NULL, deletion_id = ?, updated_at = datetime('now')
      WHERE project = ? AND file_id = ? AND state IN ('uploading', 'active')`)
      .bind(deletionId, project, fileId)
      .run();
    return await this.get(project, fileId);
  }

  async confirmVectorVisible(project: string, artifactId: string): Promise<void> {
    await this.db
      .prepare(`UPDATE kb_file_artifacts SET write_state = 'confirmed'
      WHERE project = ? AND artifact_id = ? AND kind = 'vector' AND cleanup_state = 'pending'`)
      .bind(project, artifactId)
      .run();
  }

  async cleanupCandidates(project: string, fileId: string): Promise<FileArtifact[]> {
    const result = await this.db
      .prepare(`SELECT a.* FROM kb_file_artifacts a
      JOIN kb_file_lifecycle l ON l.project = a.project AND l.file_id = a.file_id
      WHERE a.project = ? AND a.file_id = ? AND l.state = 'deleting' AND a.cleanup_state = 'pending'
      AND NOT EXISTS (SELECT 1 FROM kb_file_operations o WHERE o.project = l.project AND o.file_id = l.file_id AND o.state = 'running')`)
      .bind(project, fileId)
      .all<FileArtifact>();
    return result.results;
  }

  // A Vectorize mutation receipt is not convergence. Callers must confirm the
  // physical operation has settled before recording confirmed cleanup.
  async confirmCleanup(project: string, fileId: string, artifactId: string): Promise<boolean> {
    const result = await this.db
      .prepare(`UPDATE kb_file_artifacts SET cleanup_state = 'confirmed'
      WHERE project = ? AND file_id = ? AND artifact_id = ?
      AND EXISTS (SELECT 1 FROM kb_file_lifecycle l WHERE l.project = ? AND l.file_id = ? AND l.state = 'deleting')
      AND NOT EXISTS (SELECT 1 FROM kb_file_operations o WHERE o.project = ? AND o.file_id = ? AND o.state = 'running')`)
      .bind(project, fileId, artifactId, project, fileId, project, fileId)
      .run();
    return result.meta.changes === 1;
  }

  async finishDelete(project: string, fileId: string): Promise<boolean> {
    const result = await this.db
      .prepare(`UPDATE kb_file_lifecycle SET state = 'deleted', updated_at = datetime('now')
      WHERE project = ? AND file_id = ? AND state = 'deleting'
      AND NOT EXISTS (SELECT 1 FROM kb_file_operations o WHERE o.project = ? AND o.file_id = ? AND o.state = 'running')
      AND NOT EXISTS (SELECT 1 FROM kb_file_artifacts a WHERE a.project = ? AND a.file_id = ? AND a.cleanup_state != 'confirmed')`)
      .bind(project, fileId, project, fileId, project, fileId)
      .run();
    return result.meta.changes === 1;
  }
}
