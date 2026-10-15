import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { parseTablePreview, TABLE_PREVIEW_COLUMNS, TABLE_PREVIEW_ROWS } from "./workspace-document-preview";

export function WorkspaceTablePreview({ content, delimiter }: { content: string; delimiter: "," | "\t" }) {
  const { t } = useTranslation();
  const { rows, limited, error } = useMemo(() => parseTablePreview(content, delimiter), [content, delimiter]);
  const headers = rows[0];
  const columns = Math.max(0, ...rows.map((row) => row.length));
  return (
    <div className="workspace-table-preview">
      {error ? (
        <p role="alert" className="workspace-file-browser__error">
          {error}
        </p>
      ) : null}
      {limited ? (
        <div className="workspace-file-browser__status">
          {t("fileBrowser.tableLimit", { rows: TABLE_PREVIEW_ROWS, columns: TABLE_PREVIEW_COLUMNS })}
        </div>
      ) : null}
      <div className="workspace-table-preview__scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">#</th>
              {Array.from({ length: columns }, (_, index) => (
                <th scope="col" key={index}>
                  {headers?.[index] ?? ""}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.slice(1).map((row, rowIndex) => (
              <tr key={rowIndex}>
                <th scope="row">{rowIndex + 1}</th>
                {Array.from({ length: columns }, (_, column) => (
                  <td key={column}>{row[column] ?? ""}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
