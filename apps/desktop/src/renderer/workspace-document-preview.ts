import Papa from "papaparse";

export const TABLE_PREVIEW_ROWS = 500;
export const TABLE_PREVIEW_COLUMNS = 100;

export function parseTablePreview(content: string, delimiter: "," | "\t") {
  const parsed = Papa.parse<string[]>(content, {
    delimiter,
    skipEmptyLines: "greedy",
    preview: TABLE_PREVIEW_ROWS + 1,
  });
  const limited = parsed.meta.truncated || parsed.data.some((row) => row.length > TABLE_PREVIEW_COLUMNS);
  return {
    rows: parsed.data.map((row) => row.slice(0, TABLE_PREVIEW_COLUMNS)),
    limited,
    error: parsed.errors[0]?.message,
  };
}

export function htmlPreviewDocument(content: string, url: string | undefined): string {
  const base = url ? `<base href="${url.replaceAll("&", "&amp;").replaceAll('"', "&quot;")}">` : "";
  const policy =
    "default-src 'none'; style-src 'unsafe-inline' eco-workspace:; img-src data: blob: eco-workspace:; font-src data: eco-workspace:; media-src eco-workspace:; base-uri eco-workspace:; form-action 'none'";
  return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}">${base}${content}`;
}
