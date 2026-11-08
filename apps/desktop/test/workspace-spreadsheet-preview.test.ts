import { expect, test } from "bun:test";
import { utils, type WorkBook, type WorkSheet, write } from "xlsx";
import {
  parseSpreadsheetWorkbook,
  previewSpreadsheetSheet,
} from "../src/renderer/workspace-spreadsheet-preview";
import {
  SPREADSHEET_PREVIEW_COLUMNS,
  SPREADSHEET_PREVIEW_MAX_BYTES,
  SPREADSHEET_PREVIEW_ROWS,
} from "../src/shared/spreadsheet-preview";

function roundTrip(sheets: Record<string, WorkSheet>): WorkBook {
  const workbook = utils.book_new();
  for (const [name, sheet] of Object.entries(sheets)) utils.book_append_sheet(workbook, sheet, name);
  return parseSpreadsheetWorkbook(write(workbook, { type: "array", bookType: "xlsx" }));
}

test("XLSX preview preserves multiple sheets, coordinates, empty cells, Unicode and text", () => {
  const workbook = roundTrip({
    销售汇总: utils.aoa_to_sheet([
      ["产品", "", "金额"],
      ["磷虾油", null, 1234.5],
    ]),
    说明: utils.aoa_to_sheet([["<img src=x onerror=alert(1)>"]]),
    空表: {},
  });
  expect(workbook.SheetNames).toEqual(["销售汇总", "说明", "空表"]);
  const result = previewSpreadsheetSheet(workbook, "销售汇总");
  expect(result.columns).toEqual(["A", "B", "C"]);
  expect(result.rows.map((row) => row.cells.map((cell) => cell.text))).toEqual([
    ["产品", "", "金额"],
    ["磷虾油", "", "1234.5"],
  ]);
  expect(result.rows[1]?.cells[2]?.address).toBe("C2");
  expect(result.rows[1]?.number).toBe(2);
  expect(previewSpreadsheetSheet(workbook, "说明").rows[0]?.cells[0]?.text).toBe(
    "<img src=x onerror=alert(1)>",
  );
  expect(previewSpreadsheetSheet(workbook, "空表").rows).toEqual([]);
  expect(() => previewSpreadsheetSheet(workbook, "不存在")).toThrow("Worksheet does not exist");
});

test("XLSX preview uses number/date formats and saved formula results without calculating", () => {
  const sheet: WorkSheet = {
    "!ref": "A1:D2",
    A1: { t: "n", v: 1234.5, z: '"¥"#,##0.00' },
    B1: { t: "n", v: 45292, z: "yyyy-mm-dd" },
    C1: { t: "n", f: "1+2", v: 3 },
    D1: { t: "n", f: "SUM(A1:C1)" },
    A2: { t: "b", v: false },
    C2: { t: "n", f: "1-1", v: 0 },
  };
  const result = previewSpreadsheetSheet(roundTrip({ Sheet1: sheet }), "Sheet1");
  expect(result.rows[0]?.cells.map((cell) => cell.text)).toEqual([
    "¥1,234.50",
    "2024-01-01",
    "3",
    "=SUM(A1:C1)",
  ]);
  expect(result.rows[0]?.cells[2]?.formula).toBe("1+2");
  expect(result.rows[1]?.cells[0]?.text).toBe("FALSE");
  expect(result.rows[1]?.cells[2]?.text).toBe("0");
});

test("XLSX preview preserves merged cells and omits covered grid positions", () => {
  const sheet = utils.aoa_to_sheet([
    ["合并标题", null, "C1"],
    [null, null, "C2"],
    ["A3", "B3", "C3"],
  ]);
  sheet["!merges"] = [utils.decode_range("A1:B2")];
  const result = previewSpreadsheetSheet(roundTrip({ Sheet1: sheet }), "Sheet1");
  expect(result.rows[0]?.cells[0]).toMatchObject({ address: "A1", text: "合并标题", rowSpan: 2, colSpan: 2 });
  expect(result.rows[0]?.cells.map((cell) => cell.address)).toEqual(["A1", "C1"]);
  expect(result.rows[1]?.cells.map((cell) => cell.address)).toEqual(["C2"]);
  expect(result.rows[2]?.cells.map((cell) => cell.address)).toEqual(["A3", "B3", "C3"]);
});

test("XLSX preview bounds large ranges and clips merges at the preview boundary", () => {
  const sheet: WorkSheet = {
    "!ref": "A1:CW510",
    A1: { t: "s", v: "start" },
    CU499: { t: "s", v: "edge" },
    CW510: { t: "s", v: "outside preview" },
    "!merges": [utils.decode_range("CU499:CW510")],
  };
  const result = previewSpreadsheetSheet(roundTrip({ Sheet1: sheet }), "Sheet1");
  expect(result.rows).toHaveLength(SPREADSHEET_PREVIEW_ROWS);
  expect(result.columns).toHaveLength(SPREADSHEET_PREVIEW_COLUMNS);
  expect(result.limited).toBe(true);
  expect(result.rows[498]?.cells.at(-1)).toMatchObject({ address: "CU499", rowSpan: 2, colSpan: 2 });
  expect(result.rows[499]?.cells).toHaveLength(SPREADSHEET_PREVIEW_COLUMNS - 2);
});

test("XLSX preview retains actual coordinates when the used range starts away from A1", () => {
  const workbook = roundTrip({ Sheet1: { "!ref": "C3:C3", C3: { t: "s", v: "offset" } } });
  const result = previewSpreadsheetSheet(workbook, "Sheet1");
  expect(result.columns).toEqual(["A", "B", "C"]);
  expect(result.rows[2]?.cells[2]).toMatchObject({ address: "C3", text: "offset" });
  expect(result.rows[0]?.cells.every((cell) => cell.text === "")).toBe(true);
});

test("XLSX preview rejects invalid, renamed text, encrypted and oversized inputs", () => {
  for (const bytes of [
    new ArrayBuffer(0),
    new TextEncoder().encode("name,value\na,1").buffer,
    new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]).buffer,
  ]) {
    expect(() => parseSpreadsheetWorkbook(bytes)).toThrow("File is not an XLSX workbook");
  }
  expect(() => parseSpreadsheetWorkbook(new Uint8Array([0x50, 0x4b, 3, 4, 0, 0]).buffer)).toThrow();
  expect(() => parseSpreadsheetWorkbook(new ArrayBuffer(SPREADSHEET_PREVIEW_MAX_BYTES + 1))).toThrow(
    "exceeds 20 MiB",
  );
});
