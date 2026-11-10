import type { NodeView } from "prosemirror-view";
import { getMaterialIconUrl, resolveMaterialIconName } from "../material-file-icon";
import { probeWorkspacePath } from "../workspace-path-info";

/** Type comes from the file system, never from the path's extension or trailing slash. */
export function createWorkspacePathNodeView(dom: HTMLAnchorElement, path: string): NodeView {
  let destroyed = false;
  const icon = dom.querySelector("img");
  if (icon) icon.hidden = true;
  dom.dataset.ecoPathKind = "unresolved";
  const api = window.eco;
  if (api?.inspectWorkspacePath) {
    void probeWorkspacePath(path, api).then((info) => {
      if (destroyed) return;
      dom.dataset.ecoPathKind = info.kind;
      if (icon && info.kind !== "unsupported") {
        icon.src = getMaterialIconUrl(info.kind === "directory" ? "folder" : resolveMaterialIconName(path));
        icon.hidden = false;
      }
    }).catch((error: unknown) => {
      if (destroyed) return;
      dom.dataset.ecoPathKind = "error";
      dom.title = `${dom.title}\n${error instanceof Error ? error.message : String(error)}`;
    });
  }
  return { dom, destroy() { destroyed = true; } };
}
