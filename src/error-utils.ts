import { normalizeInputText } from "./input-normalization";

export function getErrorMessage(error: unknown, fallback = "Unknown error"): string {
  if (error instanceof Error) {
    return normalizeInputText(error.message) || fallback;
  }

  if (typeof error === "string") {
    return normalizeInputText(error) || fallback;
  }

  return fallback;
}
