import type { ParsedUpload } from './document-parser';

export function buildParseArtifact(parsed: ParsedUpload, file: { project: string; domain: string; id: string; filename: string; content_hash: string }) {
  const documents = parsed.documents.map((doc) => ({
    ...doc,
    metadata: { ...doc.metadata, project: file.project, domain: file.domain, file_id: file.id, filename: file.filename },
  }));
  return {
    parser: parsed.parser,
    parser_version: parsed.parser_version,
    project: file.project,
    domain: file.domain,
    file_id: file.id,
    filename: file.filename,
    content_hash: file.content_hash,
    record_count: parsed.record_count,
    document_count: documents.length,
    text_length: parsed.text.length,
    documents,
  };
}
