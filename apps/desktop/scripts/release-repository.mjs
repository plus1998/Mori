const DEFAULT_GITHUB_REPOSITORY = "plus1998/Mori";
const GITHUB_REPOSITORY_PATTERN = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]+)$/;

/** Long-lived GitHub Release tag that only hosts mutable channel yml pointers. */
export const DESKTOP_UPDATE_FEED_TAG = "desktop-update-feed";

export function resolveGitHubRepository(environment = process.env) {
  const value =
    environment.ECO_RELEASE_REPOSITORY?.trim() ||
    environment.GITHUB_REPOSITORY?.trim() ||
    DEFAULT_GITHUB_REPOSITORY;
  const match = GITHUB_REPOSITORY_PATTERN.exec(value);
  if (!match) {
    throw new Error(`Invalid GitHub repository: ${value}. Expected owner/repo.`);
  }
  return { slug: value, owner: match[1], repo: match[2] };
}

export function resolveDesktopUpdateFeedUrl(repository = resolveGitHubRepository()) {
  return `https://github.com/${repository.slug}/releases/download/${DESKTOP_UPDATE_FEED_TAG}`;
}

export function resolveVersionedAssetBaseUrl(repository, version) {
  const tag = version.startsWith("v") ? version : `v${version}`;
  return `https://github.com/${repository.slug}/releases/download/${tag}`;
}

/** electron-builder github publish owner/repo (legacy; prefer generic feed URL). */
export function githubPublishArgs(repository) {
  return [`--config.publish.owner=${repository.owner}`, `--config.publish.repo=${repository.repo}`];
}

export function githubGenericPublishArgs(repository) {
  return [`--config.publish.url=${resolveDesktopUpdateFeedUrl(repository)}`];
}

/**
 * Rewrite electron-updater metadata file URLs to absolute download links under a
 * versioned GitHub Release. Relative names are required when the yml lives on the
 * same Release as the binaries; the generic feed Release needs absolutes.
 */
export function absolutizeUpdateMetadata(metadata, assetBaseUrl) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error("Update metadata must be an object.");
  }
  const base = assetBaseUrl.replace(/\/$/, "");
  const files = Array.isArray(metadata.files) ? metadata.files : [];
  const nextFiles = files.map((file) => {
    if (!file || typeof file !== "object" || typeof file.url !== "string") {
      throw new Error("Update metadata contains an invalid file entry.");
    }
    return { ...file, url: toAbsoluteAssetUrl(file.url, base) };
  });
  const next = { ...metadata, files: nextFiles };
  if (typeof metadata.path === "string" && metadata.path.length > 0) {
    next.path = toAbsoluteAssetUrl(metadata.path, base);
  }
  return next;
}

function toAbsoluteAssetUrl(value, assetBaseUrl) {
  if (/^https?:\/\//i.test(value)) {
    return value;
  }
  const name = value.replace(/^\.\//, "").split("/").pop();
  if (!name) {
    throw new Error(`Invalid update asset path: ${value}`);
  }
  return `${assetBaseUrl}/${name}`;
}
