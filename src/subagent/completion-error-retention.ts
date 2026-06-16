export interface CompletionErrorRetentionInput {
  terminalFailure: boolean;
  failureSummarySource: string;
  sessionStderr: string;
  runStderr: string;
}

/**
 * Selects the error text that should be retained for task history.
 * Successful delegated completions can include stale stderr from a recovered
 * provider/auth failure, so only terminal failures should persist error text.
 */
export function selectRetainedCompletionErrorText(
  input: CompletionErrorRetentionInput,
): string {
  if (!input.terminalFailure) {
    return "";
  }

  return input.failureSummarySource || input.sessionStderr || input.runStderr || "";
}
