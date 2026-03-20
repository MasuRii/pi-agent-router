import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { discoverAgents, findNearestProjectAgentsDir } from "../agent/agent-discovery";

function runTest(name: string, testFn: () => void): void {
  testFn();
  console.log(`[PASS] ${name}`);
}

function writeAgent(
  dirPath: string,
  name: string,
  description: string,
  options: { color?: string } = {},
): void {
  mkdirSync(dirPath, { recursive: true });
  const colorLine = options.color ? `\ncolor: '${options.color}'` : "";
  writeFileSync(
    join(dirPath, `${name}.md`),
    `---\nname: ${name}\ndescription: ${description}${colorLine}\n---\n\nSystem prompt for ${name}`,
    "utf-8",
  );
}

runTest("discoverAgents honors project precedence .omp > .pi > .claude", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-discovery-precedence-"));

  try {
    writeAgent(join(root, ".claude", "agents"), "shared", "from-claude");
    writeAgent(join(root, ".pi", "agents"), "shared", "from-pi");
    writeAgent(join(root, ".omp", "agents"), "shared", "from-omp");

    const discovered = discoverAgents(root, "project");
    const shared = discovered.agents.find((agent) => agent.name === "shared");

    assert.equal(shared?.description, "from-omp");
    assert.equal(discovered.projectAgentsDir, join(root, ".omp", "agents"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

runTest("findNearestProjectAgentsDir returns nearest supported directory", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-discovery-nearest-"));
  const nested = join(root, "src", "feature");

  try {
    mkdirSync(nested, { recursive: true });
    writeAgent(join(root, ".claude", "agents"), "helper", "from-claude");

    const nearest = findNearestProjectAgentsDir(nested);
    assert.equal(nearest, join(root, ".claude", "agents"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

runTest("discoverAgents parses and normalizes frontmatter color", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-discovery-color-"));

  try {
    writeAgent(join(root, ".pi", "agents"), "colorful", "with-color", {
      color: "#50e3c2",
    });

    const discovered = discoverAgents(root, "project");
    const colorful = discovered.agents.find((agent) => agent.name === "colorful");

    assert.equal(colorful?.color, "#50E3C2");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

console.log("All agent-discovery tests passed.");
