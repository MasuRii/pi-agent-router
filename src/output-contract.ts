import type { Message } from "@mariozechner/pi-ai";

import { extractHumanReadableSubagentOutput } from "./output-sanitizer";
import { getSubagentOutputFromMessages, getToolCallArguments, normalizeInputText } from "./subagent/subagent-output";

export type OutputContractStrictness = "compat" | "strict";

export type OutputContractValidationResult = {
  outputText: string;
  submitResult?: unknown;
  warnings: string[];
  error?: string;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

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

function extractSubmitResultValue(argumentsValue: unknown): unknown {
  if (typeof argumentsValue === "string") {
    return parseJsonString(argumentsValue);
  }

  const record = asRecord(argumentsValue);
  if (!record) {
    return argumentsValue;
  }

  if ("result" in record) {
    return record.result;
  }

  if ("output" in record) {
    return record.output;
  }

  if ("value" in record) {
    return record.value;
  }

  if ("data" in record) {
    return record.data;
  }

  if ("report" in record) {
    return record.report;
  }

  return record;
}

function findLatestSubmitResult(messages: readonly Message[]): unknown {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex];
    if (!message || message.role !== "assistant") {
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
    return extracted;
  }

  if (value === undefined) {
    return "";
  }

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
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

export function validateSubagentOutputContract(options: {
  messages: readonly Message[];
  schema?: unknown;
  strictness?: OutputContractStrictness;
}): OutputContractValidationResult {
  const strictness = options.strictness === "strict" ? "strict" : "compat";
  const warnings: string[] = [];

  const submitResult = findLatestSubmitResult(options.messages);
  const hasSubmitResult = submitResult !== undefined;
  const hasSchema = options.schema !== undefined && options.schema !== null;

  if (!hasSubmitResult && hasSchema) {
    warnings.push("Subagent did not call submit_result; fell back to assistant output text.");
  }

  if (hasSubmitResult && submitResult === null) {
    warnings.push("Subagent submit_result payload was null.");
  }

  if (hasSubmitResult && hasSchema) {
    const issues = validateSchemaNode(submitResult, options.schema, "$result");
    if (issues.length > 0) {
      warnings.push(`submit_result does not satisfy schema: ${formatValidationIssues(issues)}`);
      if (strictness === "strict") {
        return {
          outputText: formatOutputValue(submitResult),
          submitResult,
          warnings,
          error: "Delegated output schema validation failed in strict mode.",
        };
      }
    }
  }

  if (!hasSubmitResult && hasSchema && strictness === "strict") {
    return {
      outputText: getSubagentOutputFromMessages(options.messages),
      warnings,
      error: "Delegated output must call submit_result when schema validation is strict.",
    };
  }

  const fallbackOutput = getSubagentOutputFromMessages(options.messages);
  const outputText = hasSubmitResult
    ? formatOutputValue(submitResult)
    : fallbackOutput;

  return {
    outputText,
    submitResult,
    warnings,
  };
}
