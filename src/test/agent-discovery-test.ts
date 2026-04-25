import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AGENT_DISCOVERY_CACHE_MAX_ENTRIES } from "../constants";
import {
  discoverAgents,
  discoverAgentsAsync,
  findNearestProjectAgentsDirAsync,
  getAgentDiscoveryCacheSnapshot,
  invalidateAgentDiscoveryCaches,
  loadAgents,
  resetAgentDiscoveryCacheState,
} from "../agent/agent-discovery";

async function runTest(name: string, testFn: () => Promise<void> | void): Promise<void> {
  await testFn();
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

await runTest("discoverAgentsAsync honors project precedence .omp > .pi > .claude", async () => {
  resetAgentDiscoveryCacheState();
  const root = mkdtempSync(join(tmpdir(), "agent-discovery-precedence-"));

  try {
    writeAgent(join(root, ".claude", "agents"), "shared", "from-claude");
    writeAgent(join(root, ".pi", "agents"), "shared", "from-pi");
    writeAgent(join(root, ".omp", "agents"), "shared", "from-omp");

    const discovered = await discoverAgentsAsync(root, "project");
    const shared = discovered.agents.find((agent) => agent.name === "shared");

    assert.equal(shared?.description, "from-omp");
    assert.equal(discovered.projectAgentsDir, join(root, ".omp", "agents"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await runTest("findNearestProjectAgentsDirAsync returns nearest supported directory", async () => {
  resetAgentDiscoveryCacheState();
  const root = mkdtempSync(join(tmpdir(), "agent-discovery-nearest-"));
  const nested = join(root, "src", "feature");

  try {
    mkdirSync(nested, { recursive: true });
    writeAgent(join(root, ".claude", "agents"), "helper", "from-claude");

    const nearest = await findNearestProjectAgentsDirAsync(nested);
    assert.equal(nearest, join(root, ".claude", "agents"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await runTest("discoverAgentsAsync parses and normalizes frontmatter color", async () => {
  resetAgentDiscoveryCacheState();
  const root = mkdtempSync(join(tmpdir(), "agent-discovery-color-"));

  try {
    writeAgent(join(root, ".pi", "agents"), "colorful", "with-color", {
      color: "#50e3c2",
    });

    const discovered = await discoverAgentsAsync(root, "project");
    const colorful = discovered.agents.find((agent) => agent.name === "colorful");

    assert.equal(colorful?.color, "#50E3C2");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await runTest("discoverAgentsAsync caches hits and rehydrates after invalidation", async () => {
  resetAgentDiscoveryCacheState();
  const root = mkdtempSync(join(tmpdir(), "agent-discovery-cache-"));
  const agentDir = join(root, ".pi", "agents");
  const agentPath = join(agentDir, "helper.md");

  try {
    writeAgent(agentDir, "helper", "from-cache");

    const first = await discoverAgentsAsync(root, "project");
    assert.equal(first.agents[0]?.description, "from-cache");

    let snapshot = getAgentDiscoveryCacheSnapshot();
    assert.equal(snapshot.discovery.misses, 1);
    assert.equal(snapshot.discovery.hits, 0);
    assert.equal(snapshot.directory.misses, 1);

    const second = await discoverAgentsAsync(root, "project");
    assert.equal(second.agents[0]?.description, "from-cache");

    snapshot = getAgentDiscoveryCacheSnapshot();
    assert.equal(snapshot.discovery.hits, 1);
    assert.equal(snapshot.discovery.misses, 1);

    writeFileSync(
      agentPath,
      `---\nname: helper\ndescription: updated-after-invalidate\n---\n\nSystem prompt for helper`,
      "utf-8",
    );

    const cached = await discoverAgentsAsync(root, "project");
    assert.equal(cached.agents[0]?.description, "from-cache");

    invalidateAgentDiscoveryCaches();

    snapshot = getAgentDiscoveryCacheSnapshot();
    assert.equal(snapshot.discovery.invalidations, 1);
    assert.equal(snapshot.directory.invalidations, 1);

    const refreshed = await discoverAgentsAsync(root, "project");
    assert.equal(refreshed.agents[0]?.description, "updated-after-invalidate");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await runTest("discoverAgentsAsync bounded caches evict least-recently-used entries", async () => {
  resetAgentDiscoveryCacheState();
  const roots: string[] = [];

  try {
    for (let index = 0; index < AGENT_DISCOVERY_CACHE_MAX_ENTRIES + 2; index += 1) {
      const root = mkdtempSync(join(tmpdir(), `agent-discovery-eviction-${index}-`));
      roots.push(root);
      writeAgent(join(root, ".pi", "agents"), `agent-${index}`, `agent-${index}`);
      await discoverAgentsAsync(root, "project");
    }

    const snapshot = getAgentDiscoveryCacheSnapshot();
    assert.equal(snapshot.discovery.size <= AGENT_DISCOVERY_CACHE_MAX_ENTRIES, true);
    assert.equal(snapshot.directory.size <= AGENT_DISCOVERY_CACHE_MAX_ENTRIES, true);
    assert.equal(snapshot.discovery.evictions >= 1, true);
    assert.equal(snapshot.directory.evictions >= 1, true);
  } finally {
    for (const root of roots) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

await runTest("discoverAgents sync API preserves cached semantics for compatibility", () => {
  resetAgentDiscoveryCacheState();
  const root = mkdtempSync(join(tmpdir(), "agent-discovery-sync-compat-"));

  try {
    writeAgent(join(root, ".pi", "agents"), "helper", "sync-compat");
    const discovered = discoverAgents(root, "project");
    assert.equal(discovered.agents[0]?.description, "sync-compat");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

await runTest("loadAgents supports project-local agents when scope includes project", () => {
  resetAgentDiscoveryCacheState();
  const root = mkdtempSync(join(tmpdir(), "agent-load-both-"));
  const projectAgentName = "project-only-active-agent";

  try {
    writeAgent(join(root, ".pi", "agents"), projectAgentName, "project-local");
    const loaded = loadAgents({ cwd: root, scope: "both" });
    const projectAgent = loaded.find((agent) => agent.name === projectAgentName);

    assert.equal(projectAgent?.description, "project-local");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

console.log("All agent-discovery tests passed.");
