#!/usr/bin/env node
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.cwd();
const sourceRoot = join(root, "src");
const forbiddenPatterns = [
  /\bconsole\.(?:log|debug|info|warn|error)\s*\(/g,
  /\bprocess\.stdout\.write\s*\(/g,
  /\bprocess\.stderr\.write\s*\(/g,
];

function collectTypeScriptFiles(dirPath) {
  const files = [];
  for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
    const entryPath = join(dirPath, entry.name);
    const relativePath = relative(root, entryPath).replace(/\\/g, "/");
    if (entry.isDirectory()) {
      if (relativePath === "src/test") {
        continue;
      }
      files.push(...collectTypeScriptFiles(entryPath));
      continue;
    }

    if (!entry.isFile() || !entry.name.endsWith(".ts")) {
      continue;
    }

    if (relativePath === "src/test.ts") {
      continue;
    }

    files.push(entryPath);
  }
  return files;
}

function lineAndColumnForIndex(source, index) {
  const prefix = source.slice(0, index);
  const lines = prefix.split("\n");
  return {
    line: lines.length,
    column: lines[lines.length - 1].length + 1,
  };
}

const violations = [];
for (const filePath of collectTypeScriptFiles(sourceRoot)) {
  const source = readFileSync(filePath, "utf-8");
  for (const pattern of forbiddenPatterns) {
    pattern.lastIndex = 0;
    for (const match of source.matchAll(pattern)) {
      const location = lineAndColumnForIndex(source, match.index ?? 0);
      violations.push(
        `${relative(root, filePath).replace(/\\/g, "/")}:${location.line}:${location.column}: ${match[0]}`,
      );
    }
  }
}

if (violations.length > 0) {
  console.error("Extension standards guard failed: terminal debug output is forbidden in non-test extension code.");
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  process.exit(1);
}

console.log("Extension standards guard passed: no console/stdout/stderr debug output in non-test extension code.");
