import type { Message } from "@mariozechner/pi-ai";

import {
  containsToolTranscriptLine,
  extractHumanReadableSubagentOutput,
  sanitizeStructuredSubagentResultForHandoff,
  sanitizeSubagentFinalResponseForHandoff,
  sanitizeSubagentResultForDisplay,
} from "./output-sanitizer";
import { asRecord } from "./record-utils";
import {
  getLatestSubagentFinalResponseFromMessages,
  getToolCallArguments,
  normalizeInputText,
} from "./subagent/subagent-output";

export type OutputContractStrictness = "compat" | "strict";

export type DelegatedOutputSource =
  | "submit_result"
  | "streamed_output"
  | "assistant_output"
  | "empty";

export type DelegatedOutputFormat = "structured" | "human_text" | "empty";

export type OutputContractValidationResult = {
  outputText: string;
  submitResult?: unknown;
  warnings: string[];
  error?: string;
  source: DelegatedOutputSource;
  format: DelegatedOutputFormat;
};

function parseJsonString(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return value;
    }
  }

  return value;
}

function normalizeSubmitResultValue(value: unknown): unknown {
  if (typeof value === "string") {
    return parseJsonString(value);
  }

  return value;
}

function extractSubmitResultValue(argumentsValue: unknown): unknown {
  if (typeof argumentsValue === "string") {
    return parseJsonString(argumentsValue);
  }

  const record = asRecord(argumentsValue);
  if (!record) {
    return argumentsValue;
  }

  if ("result" in record) {
    return normalizeSubmitResultValue(record.result);
  }

  if ("output" in record) {
    return normalizeSubmitResultValue(record.output);
  }

  if ("value" in record) {
    return normalizeSubmitResultValue(record.value);
  }

  if ("data" in record) {
    return normalizeSubmitResultValue(record.data);
  }

  if ("report" in record) {
    return normalizeSubmitResultValue(record.report);
  }

  return record;
}

function findLatestSubmitResult(messages: readonly Message[]): unknown {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex];
    if (!message || message.role !== "assistant" || !Array.isArray(message.content)) {
      continue;
    }

    for (let partIndex = message.content.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = message.content[partIndex] as unknown;
      const partRecord = asRecord(part);
      if (!partRecord || partRecord.type !== "toolCall") {
        continue;
      }

      const toolName = normalizeInputText(partRecord.name).toLowerCase();
      if (toolName !== "submit_result") {
        continue;
      }

      const argumentsValue = getToolCallArguments(partRecord);
      return extractSubmitResultValue(argumentsValue);
    }
  }

  return undefined;
}

function formatOutputValue(value: unknown): string {
  const extracted = extractHumanReadableSubagentOutput(value);
  if (extracted !== undefined) {
    return sanitizeSubagentFinalResponseForHandoff(extracted);
  }

  if (value === undefined) {
    return "";
  }

  try {
    return JSON.stringify(sanitizeStructuredSubagentResultForHandoff(value), null, 2);
  } catch {
    return String(value);
  }
}

function resolveFallbackOutput(
  messages: readonly Message[],
  finalResponseText: string | undefined,
  fallbackOutputText: string | undefined,
): {
  outputText: string;
  source: DelegatedOutputSource;
  warnings: string[];
} {
  const assistantOutput = sanitizeSubagentFinalResponseForHandoff(
    getLatestSubagentFinalResponseFromMessages(messages),
  );
  if (assistantOutput) {
    return {
      outputText: assistantOutput,
      source: "assistant_output",
      warnings: [],
    };
  }

  const capturedFinalResponse = sanitizeSubagentFinalResponseForHandoff(finalResponseText || "");
  if (capturedFinalResponse) {
    return {
      outputText: capturedFinalResponse,
      source: "assistant_output",
      warnings: [],
    };
  }

  const rawFallback = fallbackOutputText || "";
  const sanitizedFallback = sanitizeSubagentFinalResponseForHandoff(rawFallback, {
    allowPreToolTextWhenNoTrailingFinal: false,
  });
  if (sanitizedFallback) {
    return {
      outputText: sanitizedFallback,
      source: "streamed_output",
      warnings: [],
    };
  }

  const warnings = rawFallback.trim() && containsToolTranscriptLine(sanitizeSubagentResultForDisplay(rawFallback))
    ? ["No handoff-safe terminal final response was available; omitted ambiguous streamed transcript text."]
    : [];

  return {
    outputText: "",
    source: "empty",
    warnings,
  };
}

type SchemaValidationIssue = {
  path: string;
  message: string;
};

function issue(path: string, message: string): SchemaValidationIssue {
  return { path, message };
}

function valueTypeLabel(value: unknown): string {
  if (value === null) {
    return "null";
  }

  if (Array.isArray(value)) {
    return "array";
  }

  return typeof value;
}

function checkPrimitiveType(expectedType: string, value: unknown): boolean {
  if (expectedType === "array") {
    return Array.isArray(value);
  }

  if (expectedType === "object") {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
  }

  if (expectedType === "integer") {
    return typeof value === "number" && Number.isInteger(value);
  }

  if (expectedType === "null") {
    return value === null;
  }

  return typeof value === expectedType;
}

function validateSchemaNode(value: unknown, schema: unknown, path: string): SchemaValidationIssue[] {
  const schemaRecord = asRecord(schema);
  if (!schemaRecord) {
    return [];
  }

  if (Array.isArray(schemaRecord.oneOf) && schemaRecord.oneOf.length > 0) {
    for (const branch of schemaRecord.oneOf) {
      if (validateSchemaNode(value, branch, path).length === 0) {
        return [];
      }
    }

    return [issue(path, "did not match any oneOf schema branch")];
  }

  if (Array.isArray(schemaRecord.anyOf) && schemaRecord.anyOf.length > 0) {
    for (const branch of schemaRecord.anyOf) {
      if (validateSchemaNode(value, branch, path).length === 0) {
        return [];
      }
    }

    return [issue(path, "did not match any anyOf schema branch")];
  }

  const issues: SchemaValidationIssue[] = [];

  if ("const" in schemaRecord && value !== schemaRecord.const) {
    issues.push(issue(path, `expected constant ${JSON.stringify(schemaRecord.const)}, got ${JSON.stringify(value)}`));
  }

  if (Array.isArray(schemaRecord.enum) && schemaRecord.enum.length > 0) {
    const inEnum = schemaRecord.enum.some((entry) => entry === value);
    if (!inEnum) {
      issues.push(issue(path, `expected one of ${JSON.stringify(schemaRecord.enum)}, got ${JSON.stringify(value)}`));
    }
  }

  const schemaType = schemaRecord.type;
  if (typeof schemaType === "string") {
    if (!checkPrimitiveType(schemaType, value)) {
      issues.push(issue(path, `expected type '${schemaType}', got '${valueTypeLabel(value)}'`));
      return issues;
    }
  }

  if (typeof value === "string") {
    if (typeof schemaRecord.minLength === "number" && value.length < schemaRecord.minLength) {
      issues.push(issue(path, `expected minLength ${schemaRecord.minLength}, got ${value.length}`));
    }

    if (typeof schemaRecord.maxLength === "number" && value.length > schemaRecord.maxLength) {
      issues.push(issue(path, `expected maxLength ${schemaRecord.maxLength}, got ${value.length}`));
    }

    if (typeof schemaRecord.pattern === "string") {
      try {
        const pattern = new RegExp(schemaRecord.pattern);
        if (!pattern.test(value)) {
          issues.push(issue(path, `expected pattern /${schemaRecord.pattern}/`));
        }
      } catch {
        issues.push(issue(path, `contains invalid pattern '${schemaRecord.pattern}'`));
      }
    }
  }

  if (typeof value === "number") {
    if (typeof schemaRecord.minimum === "number" && value < schemaRecord.minimum) {
      issues.push(issue(path, `expected minimum ${schemaRecord.minimum}, got ${value}`));
    }

    if (typeof schemaRecord.maximum === "number" && value > schemaRecord.maximum) {
      issues.push(issue(path, `expected maximum ${schemaRecord.maximum}, got ${value}`));
    }
  }

  if (Array.isArray(value)) {
    if (typeof schemaRecord.minItems === "number" && value.length < schemaRecord.minItems) {
      issues.push(issue(path, `expected minItems ${schemaRecord.minItems}, got ${value.length}`));
    }

    if (typeof schemaRecord.maxItems === "number" && value.length > schemaRecord.maxItems) {
      issues.push(issue(path, `expected maxItems ${schemaRecord.maxItems}, got ${value.length}`));
    }

    if (schemaRecord.items) {
      for (let index = 0; index < value.length; index += 1) {
        issues.push(...validateSchemaNode(value[index], schemaRecord.items, `${path}[${index}]`));
      }
    }
  }

  const valueRecord = asRecord(value);
  if (valueRecord) {
    const properties = asRecord(schemaRecord.properties) ?? {};
    const required = Array.isArray(schemaRecord.required)
      ? schemaRecord.required.filter((entry): entry is string => typeof entry === "string")
      : [];

    for (const requiredKey of required) {
      if (!(requiredKey in valueRecord)) {
        issues.push(issue(`${path}.${requiredKey}`, "is required"));
      }
    }

    for (const [key, childSchema] of Object.entries(properties)) {
      if (!(key in valueRecord)) {
        continue;
      }
      issues.push(...validateSchemaNode(valueRecord[key], childSchema, `${path}.${key}`));
    }

    if (schemaRecord.additionalProperties === false) {
      const allowedKeys = new Set(Object.keys(properties));
      for (const key of Object.keys(valueRecord)) {
        if (!allowedKeys.has(key)) {
          issues.push(issue(`${path}.${key}`, "is not allowed by schema"));
        }
      }
    }
  }

  return issues;
}

function formatValidationIssues(issues: readonly SchemaValidationIssue[]): string {
  return issues.map((entry) => `${entry.path} ${entry.message}`).join("; ");
}

export function normalizeDelegatedOutput(options: {
  messages?: readonly Message[];
  finalResponseText?: string;
  fallbackOutputText?: string;
  schema?: unknown;
  strictness?: OutputContractStrictness;
}): OutputContractValidationResult {
  const messages = Array.isArray(options.messages) ? options.messages : [];
  const strictness = options.strictness === "strict" ? "strict" : "compat";
  const warnings: string[] = [];

  const submitResult = findLatestSubmitResult(messages);
  const hasSubmitResult = submitResult !== undefined;
  const hasSchema = options.schema !== undefined && options.schema !== null;
  const fallback = resolveFallbackOutput(messages, options.finalResponseText, options.fallbackOutputText);
  warnings.push(...fallback.warnings);

  let outputText = fallback.outputText;
  let source = fallback.source;
  let format: DelegatedOutputFormat = fallback.outputText ? "human_text" : "empty";

  if (hasSubmitResult) {
    outputText = formatOutputValue(submitResult);
    source = "submit_result";
    format = "structured";
  }

  if (hasSubmitResult && submitResult === null) {
    warnings.push("Subagent submit_result payload was null.");
  }

  if (hasSchema) {
    if (!hasSubmitResult) {
      warnings.push(
        "Structured output schema was provided, but the subagent returned a human-readable final response instead of submit_result. Preserved the final response text.",
      );
      if (strictness === "strict") {
        return {
          outputText,
          warnings,
          error: "Delegated output must call submit_result when schema validation is strict.",
          source,
          format,
        };
      }
    } else {
      const issues = validateSchemaNode(submitResult, options.schema, "$result");
      if (issues.length > 0) {
        warnings.push(`submit_result does not satisfy schema: ${formatValidationIssues(issues)}`);
        if (strictness === "strict") {
          return {
            outputText,
            submitResult,
            warnings,
            error: "Delegated output schema validation failed in strict mode.",
            source,
            format,
          };
        }
      }
    }
  }

  return {
    outputText,
    submitResult,
    warnings,
    source,
    format,
  };
}

export function validateSubagentOutputContract(options: {
  messages: readonly Message[];
  schema?: unknown;
  strictness?: OutputContractStrictness;
}): OutputContractValidationResult {
  return normalizeDelegatedOutput(options);
}
