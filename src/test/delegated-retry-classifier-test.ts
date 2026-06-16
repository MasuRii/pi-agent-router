import assert from "node:assert/strict";

import { classifyDelegatedRetryableFailure } from "../subagent/delegated-retry-classifier";

function runTest(name: string, testFn: () => Promise<void> | void): Promise<void> {
  return Promise.resolve(testFn()).then(() => {
    console.log(`[PASS] ${name}`);
  });
}

await runTest("concurrency limit exceeded for account is a retryable quota failure", () => {
  const failure = classifyDelegatedRetryableFailure(
    "Concurrency limit exceeded for account, please retry later",
    { providerId: "dawnxai", modelId: "gpt-5.5" },
  );

  assert.ok(failure);
  assert.equal(failure.kind, "quota");
  assert.match(failure.message, /concurrency limit/i);
});

await runTest("concurrency limit exceeded for user is a retryable quota failure", () => {
  const failure = classifyDelegatedRetryableFailure(
    "Concurrency limit exceeded for user, please retry later",
    { providerId: "anteasy", modelId: "gpt-5.5" },
  );

  assert.ok(failure);
  assert.equal(failure.kind, "quota");
  assert.match(failure.message, /concurrency limit/i);
});

await runTest("'Stream ended without finish_reason' is a retryable transient failure", () => {
  const failure = classifyDelegatedRetryableFailure(
    "Stream ended without finish_reason",
    { providerId: "qianxiang", modelId: "gpt-5.5-openai-compact" },
  );

  assert.ok(failure);
  assert.equal(failure.kind, "transient");
  assert.match(failure.message, /finish_reason/i);
});

await runTest("standalone 'Connection error.' is a retryable transient failure", () => {
  const failure = classifyDelegatedRetryableFailure(
    "Connection error.",
    { providerId: "lxc", modelId: "gpt-5.5" },
  );

  assert.ok(failure);
  assert.equal(failure.kind, "transient");
  assert.match(failure.message, /connection error/i);
});

await runTest("bare 'terminated' string is a retryable transient failure", () => {
  const failure = classifyDelegatedRetryableFailure(
    "terminated",
    { providerId: "dawnxai", modelId: "gpt-5.5" },
  );

  assert.ok(failure);
  assert.equal(failure.kind, "transient");
  assert.equal(failure.message, "terminated");
});

await runTest("Cockpit-style network transport errors are retryable transient failures", () => {
  const retryableMessages = [
    "read tcp 192.168.254.101:35829->172.64.155.209:443: wsarecv: An existing connection was forcibly closed by the remote host.",
    "error sending request for url (https://example.invalid)",
    "failed to send request: getaddrinfo ENOTFOUND api.example.invalid",
    "getaddrinfo EAI_AGAIN api.example.invalid",
    "request failed: ECONNABORTED",
    "write: broken pipe",
    "stream read failed: unexpected EOF",
    "dial tcp: lookup api.example.invalid: name or service not known",
    "connect: no route to host",
    "network is unreachable",
  ];

  for (const message of retryableMessages) {
    const failure = classifyDelegatedRetryableFailure(message, {
      providerId: "openai-codex",
      modelId: "gpt-5.5",
    });

    assert.ok(failure, message);
    assert.equal(failure.kind, "transient", message);
    assert.equal(failure.message, message);
  }
});
