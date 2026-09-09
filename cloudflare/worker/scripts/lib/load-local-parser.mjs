import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';

// Offline Node 24 CLI only. Resolve this repository's extensionless TypeScript
// imports; the runtime parser itself remains unchanged and receives no AI binding.
export async function loadLocalParser() {
  const root = new URL('../../src/', import.meta.url).href;
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier.startsWith('.') && context.parentURL?.startsWith(root)) {
        const candidate = new URL(`${specifier}.ts`, context.parentURL);
        if (existsSync(candidate)) return nextResolve(candidate.href, context);
      }
      return nextResolve(specifier, context);
    },
  });
  try {
    const [{ parseUploadBytes }, { buildParseArtifact }] = await Promise.all([import('../../src/document-parser.ts'), import('../../src/parse-artifact.ts')]);
    return { parseUploadBytes, buildParseArtifact };
  } finally {
    hooks.deregister();
  }
}
