import type { WorkBook } from "xlsx";
import type { SpreadsheetPreviewRequest, SpreadsheetPreviewResponse } from "../shared/spreadsheet-preview";
import { parseSpreadsheetWorkbook, previewSpreadsheetSheet } from "./workspace-spreadsheet-preview";

let workbook: WorkBook | undefined;

self.onmessage = (event: MessageEvent<SpreadsheetPreviewRequest>) => {
  let response: SpreadsheetPreviewResponse;
  try {
    if (event.data.type === "load") {
      workbook = parseSpreadsheetWorkbook(event.data.bytes);
      const firstName = workbook.SheetNames[0];
      if (firstName === undefined) throw new Error("Workbook contains no worksheets.");
      response = {
        type: "loaded",
        names: workbook.SheetNames,
        sheet: previewSpreadsheetSheet(workbook, firstName),
      };
    } else {
      if (!workbook) throw new Error("Workbook has not loaded.");
      response = { type: "sheet", sheet: previewSpreadsheetSheet(workbook, event.data.name) };
    }
  } catch (error) {
    response = { type: "error", message: error instanceof Error ? error.message : String(error) };
  }
  self.postMessage(response);
};
