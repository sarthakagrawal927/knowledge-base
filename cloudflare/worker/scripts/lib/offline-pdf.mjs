// Offline-only dependency: never import this module from src/.
import { getDocument, version } from 'pdfjs-dist/legacy/build/pdf.mjs';

export async function parseOfflinePdf(filename, bytes) {
  const task = getDocument({
    data: new Uint8Array(bytes),
    isEvalSupported: false,
    useSystemFonts: false,
    disableFontFace: true,
    useWorkerFetch: false,
    stopAtErrors: true,
    verbosity: 0,
  });
  try {
    const pdf = await task.promise;
    if (pdf.numPages > 500) return { reason: 'pdf-page-limit-exceeded' };
    const documents = [];
    let textLength = 0;
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const extracted = await page.getTextContent();
      const content = extracted.items
        .map((item) => ('str' in item ? `${item.str}${item.hasEOL ? '\n' : ' '}` : ''))
        .join('')
        .trim();
      page.cleanup();
      // A blank page may be intentional or scanned. Neither is silently omitted.
      if (!content) return { reason: 'pdf-page-without-text-needs-review-or-ocr' };
      textLength += content.length;
      if (textLength > 8 * 1024 * 1024) return { reason: 'pdf-text-limit-exceeded' };
      documents.push({
        external_id: `${filename}:page:${pageNumber}`,
        content,
        metadata: { filename, parser_source: 'pdf', page: pageNumber, excerpt: content.slice(0, 1000) },
      });
    }
    return {
      parsed: {
        parser: 'offline-pdfjs',
        parser_version: version,
        documents,
        text: documents.map((document) => document.content).join('\n\n'),
        page_count: pdf.numPages,
        record_count: 0,
      },
    };
  } catch (error) {
    return { reason: error?.name === 'PasswordException' ? 'pdf-password-required' : 'pdf-invalid-or-unsupported' };
  } finally {
    await task.destroy();
  }
}
