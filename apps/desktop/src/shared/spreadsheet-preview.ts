export const SPREADSHEET_PREVIEW_MAX_BYTES = 20 * 1024 * 1024;
export const SPREADSHEET_PREVIEW_ROWS = 500;
export const SPREADSHEET_PREVIEW_COLUMNS = 100;

export interface SpreadsheetPreviewCell {
  address: string;
  text: string;
  formula?: string;
  rowSpan: number;
  colSpan: number;
}

export interface SpreadsheetPreviewSheet {
  name: string;
  columns: string[];
  rows: { number: number; cells: SpreadsheetPreviewCell[] }[];
  limited: boolean;
}

export type SpreadsheetPreviewRequest =
  | { type: "load"; bytes: ArrayBuffer }
  | { type: "sheet"; name: string };

export type SpreadsheetPreviewResponse =
  | { type: "loaded"; names: string[]; sheet: SpreadsheetPreviewSheet }
  | { type: "sheet"; sheet: SpreadsheetPreviewSheet }
  | { type: "error"; message: string };
