import { read, utils, type WorkBook } from "xlsx";
import {
  SPREADSHEET_PREVIEW_COLUMNS,
  SPREADSHEET_PREVIEW_MAX_BYTES,
  SPREADSHEET_PREVIEW_ROWS,
  type SpreadsheetPreviewCell,
  type SpreadsheetPreviewSheet,
} from "../shared/spreadsheet-preview";

export function parseSpreadsheetWorkbook(bytes: ArrayBuffer): WorkBook {
  if (bytes.byteLength > SPREADSHEET_PREVIEW_MAX_BYTES) throw new Error("Spreadsheet exceeds 20 MiB.");
  const signature = new Uint8Array(bytes, 0, Math.min(4, bytes.byteLength));
  if (signature[0] !== 0x50 || signature[1] !== 0x4b || signature[2] !== 3 || signature[3] !== 4)
    throw new Error("File is not an XLSX workbook. Encrypted workbooks are not supported.");
  const workbook = read(bytes, {
    type: "array",
    dense: true,
    sheetRows: SPREADSHEET_PREVIEW_ROWS + 1,
    cellText: true,
    cellHTML: false,
  });
  if (!workbook.SheetNames.length) throw new Error("Workbook contains no worksheets.");
  return workbook;
}

export function previewSpreadsheetSheet(workbook: WorkBook, name: string): SpreadsheetPreviewSheet {
  const sheet = workbook.Sheets[name];
  if (!sheet) throw new Error(`Worksheet does not exist: ${name}`);
  const reference = sheet["!fullref"] ?? sheet["!ref"];
  if (!reference) return { name, columns: [], rows: [], limited: false };
  const range = utils.decode_range(reference);
  const rowCount = Math.min(range.e.r + 1, SPREADSHEET_PREVIEW_ROWS);
  const columnCount = Math.min(range.e.c + 1, SPREADSHEET_PREVIEW_COLUMNS);
  const covered = new Set<number>();
  const spans = new Map<number, { rowSpan: number; colSpan: number }>();
  for (const merge of sheet["!merges"] ?? []) {
    if (merge.s.r >= rowCount || merge.s.c >= columnCount) continue;
    const endRow = Math.min(merge.e.r, rowCount - 1);
    const endColumn = Math.min(merge.e.c, columnCount - 1);
    const anchor = merge.s.r * columnCount + merge.s.c;
    spans.set(anchor, { rowSpan: endRow - merge.s.r + 1, colSpan: endColumn - merge.s.c + 1 });
    for (let row = merge.s.r; row <= endRow; row++) {
      for (let column = merge.s.c; column <= endColumn; column++) {
        const position = row * columnCount + column;
        if (position !== anchor) covered.add(position);
      }
    }
  }
  const rows: SpreadsheetPreviewSheet["rows"] = [];
  for (let row = 0; row < rowCount; row++) {
    const cells: SpreadsheetPreviewCell[] = [];
    for (let column = 0; column < columnCount; column++) {
      const position = row * columnCount + column;
      if (covered.has(position)) continue;
      const address = utils.encode_cell({ r: row, c: column });
      const cell = sheet["!data"]?.[row]?.[column] ?? sheet[address];
      const formula = cell?.f as string | undefined;
      cells.push({
        address,
        text: formula && cell.v === undefined ? `=${formula}` : cell ? utils.format_cell(cell) : "",
        ...(formula ? { formula } : {}),
        ...(spans.get(position) ?? { rowSpan: 1, colSpan: 1 }),
      });
    }
    rows.push({ number: row + 1, cells });
  }
  return {
    name,
    columns: Array.from({ length: columnCount }, (_, column) => utils.encode_col(column)),
    rows,
    limited: range.e.r >= SPREADSHEET_PREVIEW_ROWS || range.e.c >= SPREADSHEET_PREVIEW_COLUMNS,
  };
}
