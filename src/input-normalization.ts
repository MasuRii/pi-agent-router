/**
 * Shared input text normalization utilities.
 */

export function normalizeInputText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
