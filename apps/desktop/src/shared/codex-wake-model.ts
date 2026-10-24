/** Only versioned Luna models qualify; catalog order and the general default can change. */
export function latestLunaModelId(modelIds: readonly string[]): string | undefined {
  return modelIds
    .filter((id) => /^gpt-\d+(?:\.\d+)*-luna$/.test(id))
    .sort((a, b) => b.localeCompare(a, "en", { numeric: true }))[0];
}
