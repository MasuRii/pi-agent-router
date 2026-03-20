import assert from "node:assert/strict";

import { Container } from "@mariozechner/pi-tui";

import { appendTaskBlock } from "../task/task-display-primitives";
import { createAnimatedRenderSurface } from "../ui/animated-render-surface";

async function runTest(name: string, testFn: () => void | Promise<void>): Promise<void> {
  await testFn();
  console.log(`[PASS] ${name}`);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

await runTest("createAnimatedRenderSurface forwards immediate render requests", async () => {
  let renderRequests = 0;
  const surface = createAnimatedRenderSurface(
    {
      requestRender: () => {
        renderRequests += 1;
      },
    },
    {
      shouldRender: () => false,
      intervalMs: 80,
    },
  );

  surface.requestRender();
  surface.dispose();

  assert.equal(renderRequests, 1);
});

await runTest("createAnimatedRenderSurface drives aligned spinner ticks only while allowed", async () => {
  let renderRequests = 0;
  let now = 79;
  const surface = createAnimatedRenderSurface(
    {
      requestRender: () => {
        renderRequests += 1;
      },
    },
    {
      intervalMs: 80,
      now: () => now,
      shouldRender: () => renderRequests === 0,
    },
  );

  await sleep(20);
  surface.dispose();

  assert.equal(renderRequests, 1);
});

await runTest("appendTaskBlock re-samples braille spinner frames across renders", () => {
  const container = new Container();
  appendTaskBlock(container, {
    fg: (_color, text) => text,
  }, {
    title: "Security Task",
    description: "Review auth flow",
    activity: "Running",
    status: "running",
    spinner: true,
  });

  const originalNow = Date.now;

  try {
    Date.now = () => 0;
    const firstRender = container.render(120).join("\n");

    Date.now = () => 80;
    const secondRender = container.render(120).join("\n");

    assert.equal(firstRender.includes("⠋ Security Task"), true);
    assert.equal(secondRender.includes("⠙ Security Task"), true);
  } finally {
    Date.now = originalNow;
  }
});

console.log("All spinner surface tests passed.");
