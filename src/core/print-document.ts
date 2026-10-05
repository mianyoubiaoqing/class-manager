/** Internal validated print artifact; never accepted from Renderer or through IPC input. */
export interface PrintDocument {
  html: string;
  pageCount: number;
  versionId: string;
  revision: number;
  pageOffset?: number;
  totalPageCount?: number;
}

export const PRINT_BATCH_PAGES = 100;
export const PRINT_BATCH_BYTES = 2 * 1024 * 1024;

export const escapePrintHtml = (text: string): string =>
  text.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    };
    return entities[character]!;
  });
