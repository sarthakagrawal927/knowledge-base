-- Source-only additive recovery boundary; never infer old intent dispatch state.
ALTER TABLE kb_file_artifacts ADD COLUMN dispatch_state TEXT NOT NULL DEFAULT 'unknown'
  CHECK (dispatch_state IN ('unknown', 'prepared', 'started'));
