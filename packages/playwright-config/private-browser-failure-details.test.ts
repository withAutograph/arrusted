import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const helper = fileURLToPath(new URL("./private-browser-diagnostics.cjs", import.meta.url));
const reporter = fileURLToPath(new URL("./private-preview-reporter.js", import.meta.url));
const canary = "PRIVATE_BROWSER_VALUE_SENTINEL";

/** Execute the maintained CJS boundary without adding a test-only public export or declaration. */
const project = (messages: readonly unknown[]): unknown => {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=commonjs",
      "-e",
      `const { readFileSync } = require("node:fs");
const { privateBrowserFailureDetail } = require(${JSON.stringify(helper)});
const messages = JSON.parse(readFileSync(0, "utf8"));
process.stdout.write(JSON.stringify(messages.map((message) => privateBrowserFailureDetail(message) ?? null)));`,
    ],
    { input: JSON.stringify(messages), encoding: "utf8" },
  );
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout + result.stderr).not.toContain(canary);
  const parsed: unknown = JSON.parse(result.stdout);
  return parsed;
};

describe("value-free private browser failure details", () => {
  it("distinguishes a missing locator from an ambiguous action and an ordinary action timeout", () => {
    expect(
      project([
        `Error: expect(locator).toBeVisible() failed\nLocator: getByText('${canary}')\nExpected: visible\nError: element(s) not found\nCall log:\n  - waiting for getByText('${canary}')`,
        `locator.click: Error: strict mode violation: getByRole('button', {name: '${canary}'}) resolved to 2 elements:\n1) <button>${canary}</button>`,
        `locator.fill: Timeout 5000ms exceeded.\nCall log:\n  - waiting for getByLabel('${canary}')\n  - element is not enabled`,
        `locator.waitFor: Timeout 5000ms exceeded.\nCall log: waiting for locator('${canary}')`,
      ]),
    ).toEqual([
      { kind: "locator-not-found", matcher: "toBeVisible", negated: false },
      { kind: "locator-ambiguous", operation: "locator.click" },
      { kind: "action-timeout", operation: "locator.fill" },
      { kind: "action-timeout", operation: "locator.waitFor" },
    ]);
  });

  it("recognizes only the exact unquoted Received missing-locator line", () => {
    expect(
      project([
        `expect(locator).toBeVisible() failed\nLocator: getByText('${canary}')\nExpected: visible\nReceived: <element(s) not found>\nCall log:\n  - ${canary}`,
        `\u001b[31mError:\u001b[39m expect(locator).not.toBeAttached() failed\r\nLocator: ${canary}\r\nReceived: \u001b[31m<element(s) not found>\u001b[39m\r\nCall log:\r\n  - ${canary}`,
      ]),
    ).toEqual([
      { kind: "locator-not-found", matcher: "toBeVisible", negated: false },
      { kind: "locator-not-found", matcher: "toBeAttached", negated: true },
    ]);
  });

  it("does not confuse quoted text, expected values, suffixes or action timeouts with a missing locator", () => {
    expect(
      project([
        `expect(locator).toHaveText(expected) failed\nExpected string: '${canary}'\nReceived string: "<element(s) not found>"`,
        `expect(locator).toHaveText(expected) failed\nExpected: <element(s) not found>\nReceived: '${canary}'`,
        `expect(locator).toBeVisible() failed\nReceived: <element(s) not found> ${canary}`,
        `expect(locator).toBeVisible() failed\nReceived: <element(s) not found>${canary}`,
        `Unexpected ${canary}\nReceived: <element(s) not found>`,
        `locator.waitFor: Timeout 25ms exceeded.\nCall log:\n  - Received: <element(s) not found> ${canary}`,
      ]),
    ).toEqual([
      { kind: "assertion-mismatch", matcher: "toHaveText", negated: false },
      { kind: "assertion-mismatch", matcher: "toHaveText", negated: false },
      { kind: "assertion-mismatch", matcher: "toBeVisible", negated: false },
      { kind: "assertion-mismatch", matcher: "toBeVisible", negated: false },
      null,
      { kind: "action-timeout", operation: "locator.waitFor" },
    ]);
  });

  it("reports only known matcher identity and negation, never expected or received values", () => {
    expect(
      project([
        `Error: expect(locator).toHaveText(expected) failed\nExpected string: '${canary}'\nReceived string: '${canary}'`,
        `Error: expect(received).not.toEqual(expected)\nExpected: not ${canary}\nReceived: ${canary}`,
        `expect(page).toHaveURL(expected) failed\nExpected: https://private.invalid/${canary}?token=${canary}\nReceived: https://other.invalid/${canary}`,
        `expect(locator).toHaveAttribute(name, value) failed\nAttribute: data-${canary}\nExpected: ${canary}`,
      ]),
    ).toEqual([
      { kind: "assertion-mismatch", matcher: "toHaveText", negated: false },
      { kind: "assertion-mismatch", matcher: "toEqual", negated: true },
      { kind: "assertion-mismatch", matcher: "toHaveURL", negated: false },
      { kind: "assertion-mismatch", matcher: "toHaveAttribute", negated: false },
    ]);
  });

  it("handles ANSI formatting while keeping captured application values out of the result", () => {
    expect(
      project([
        `\u001b[31mError:\u001b[39m expect(locator).not.toHaveCount(expected) failed\r\nExpected: ${canary}\r\nReceived: ${canary}`,
      ]),
    ).toEqual([{ kind: "assertion-mismatch", matcher: "toHaveCount", negated: true }]);
  });

  it("separates navigation timeouts from closed network failure reasons", () => {
    expect(
      project([
        `page.goto: Timeout 10000ms exceeded.\nCall log: navigating to https://private.invalid/${canary}`,
        `frame.waitForURL: Timeout 10000ms exceeded.\nExpected URL: https://private.invalid/${canary}`,
        ...[
          "ERR_CONNECTION_REFUSED",
          "ERR_NAME_NOT_RESOLVED",
          "ERR_CERT_AUTHORITY_INVALID",
          "ERR_CONNECTION_RESET",
          "ERR_ABORTED",
          "ERR_HTTP_RESPONSE_CODE_FAILURE",
        ].map(
          (reason) =>
            `page.goto: net::${reason} at https://private.invalid/${canary}?token=${canary}`,
        ),
      ]),
    ).toEqual([
      { kind: "navigation-timeout", operation: "page.goto" },
      { kind: "navigation-timeout", operation: "frame.waitForURL" },
      { kind: "navigation-network", operation: "page.goto", network: "connection-refused" },
      { kind: "navigation-network", operation: "page.goto", network: "dns-failure" },
      { kind: "navigation-network", operation: "page.goto", network: "tls-failure" },
      { kind: "navigation-network", operation: "page.goto", network: "connection-reset" },
      { kind: "navigation-network", operation: "page.goto", network: "aborted" },
      { kind: "navigation-http-response", operation: "page.goto", network: "http-response-error" },
    ]);
  });

  it("omits unsupported operations, matchers, reasons and arbitrary error text", () => {
    const messages = [
      `locator.${canary}: Timeout 5000ms exceeded.`,
      `expect(locator).${canary}(expected) failed\nError: element(s) not found`,
      `page.goto: net::ERR_${canary} at https://private.invalid/`,
      `Unexpected application error ${canary}: strict mode violation:`,
      `Unexpected application error ${canary}: element(s) not found`,
      `Expected status 200 but received 403: ${canary}`,
      `Test timeout of 25000ms exceeded: ${canary}`,
      null,
      42,
      { message: canary },
    ];
    expect(project(messages)).toEqual(messages.map(() => null));
  });

  it("leaves unsupported reasons on known APIs withheld rather than guessing app state", () => {
    expect(
      project([
        `locator.click: ${canary}`,
        `page.goto: ${canary}`,
        `expect(${canary}).toBe(expected) failed`,
      ]),
    ).toEqual([null, null, null]);
  });
});

it("reports compatible missing-locator wire results through the installed matcher and real reporter", () => {
  const file = path.join(process.cwd(), "tests", "e2e", "received-detail.spec.ts");
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import Reporter from ${JSON.stringify(reporter)};
import { expect } from ${JSON.stringify(import.meta.resolve("playwright/test"))};
import { stripVTControlCharacters } from "node:util";
const locator = {
  _apiName: "Locator",
  toString: () => "getByText(" + ${JSON.stringify(canary)} + ")",
  _expect: async () => ({matches: false, received: {value: "<element(s) not found>"}, timedOut: true, log: [${JSON.stringify(canary)}]})
};
const messages = [];
try { await expect(locator).toBeVisible({timeout: 5}); }
catch (error) { messages.push(error.message); }
try { await expect(locator).toHaveText(${JSON.stringify(canary)}, {timeout: 5}); }
catch (error) { messages.push(error.message); }
if (messages.length !== 2 || !/\\nReceived:\\s+<element\\(s\\) not found>\\r?\\n/.test(stripVTControlCharacters(messages[0])) || !/\\nReceived:\\s+"<element\\(s\\) not found>"\\r?\\n/.test(stripVTControlCharacters(messages[1]))) {
  throw new Error("Controlled matcher wire did not produce the expected Received forms");
}
const reporter = new Reporter();
reporter.onTestEnd({titlePath: () => ["safe compatible matcher fixture"], location: {file: ${JSON.stringify(file)}, line: 7}}, {
  status: "failed",
  errors: messages.map((message) => ({message}))
});
reporter.onEnd({status: "failed"});`,
    ],
    { encoding: "utf8" },
  );
  expect(result.status, result.stderr).toBe(0);
  const output = result.stdout + result.stderr;
  const prefix = "[private browser diagnostic] ";
  const details: unknown[] = result.stdout
    .split(/\r?\n/u)
    .filter((line) => line.startsWith(prefix))
    .map((line) => JSON.parse(line.slice(prefix.length)));
  expect(details).toHaveLength(2);
  expect(details).toContainEqual({
    basis: "error-message-signature",
    kind: "locator-not-found",
    matcher: "toBeVisible",
    negated: false,
  });
  expect(details).toContainEqual({
    basis: "error-message-signature",
    kind: "assertion-mismatch",
    matcher: "toHaveText",
    negated: false,
  });
  expect(output).toContain("[application-test-failure; raw diagnostics withheld]");
  expect(output).toContain("[private browser] run failed");
  for (const value of [canary, "getByText", "Expected:", "Received:", "<element(s) not found>"]) {
    expect(output).not.toContain(value);
  }
});

it("prints closed detail from the actual reporter without error values, snippets, URLs or worker output", () => {
  const file = path.join(process.cwd(), "tests", "e2e", "private-detail.spec.ts");
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import Reporter from ${JSON.stringify(reporter)};
import { readFileSync } from "node:fs";
import { expect } from ${JSON.stringify(import.meta.resolve("playwright/test"))};
const messages = JSON.parse(readFileSync(0, "utf8"));
try { expect(${JSON.stringify(canary)}).toBe(${JSON.stringify(`different-${canary}`)}); }
catch (error) { messages.push(error.message); }
const reporter = new Reporter();
for (const message of messages) {
  reporter.onTestEnd({titlePath: () => ["safe private detail fixture"], location: {file: ${JSON.stringify(file)}, line: 7}}, {
    status: "failed",
    errors: [{message, stack: ${JSON.stringify(canary)}, snippet: ${JSON.stringify(canary)}, value: ${JSON.stringify(canary)}, location: {file: ${JSON.stringify(file)}, line: 11}}],
    stdout: [${JSON.stringify(canary)}],
    stderr: [${JSON.stringify(canary)}]
  });
}
reporter.onError({message: "page.goto: net::ERR_CONNECTION_REFUSED at https://private.invalid/" + ${JSON.stringify(canary)}});
reporter.onError({message: "unsupported " + ${JSON.stringify(canary)}});
reporter.onEnd({status: "failed"});`,
    ],
    {
      input: JSON.stringify([
        `Error: expect(locator).toHaveText(expected) failed\nExpected: ${canary}\nReceived: ${canary}`,
        `locator.click: Error: strict mode violation: getByText('${canary}') resolved to 2 elements`,
        `unsupported ${canary}`,
      ]),
      encoding: "utf8",
    },
  );
  expect(result.status, result.stderr).toBe(0);
  const output = result.stdout + result.stderr;
  expect(output).toContain("[private browser failure] tests/e2e/private-detail.spec.ts:11");
  expect(output).toContain("[application-test-failure; raw diagnostics withheld]");
  expect(output).toContain("[private browser] run failed");
  for (const value of [canary, "private.invalid", "getByText", "Expected:", "Received:"]) {
    expect(output).not.toContain(value);
  }
  const prefix = "[private browser diagnostic] ";
  const details: unknown[] = result.stdout
    .split(/\r?\n/u)
    .filter((line) => line.startsWith(prefix))
    .map((line) => JSON.parse(line.slice(prefix.length)));
  expect(details).toHaveLength(4);
  expect(details).toContainEqual({
    basis: "error-message-signature",
    kind: "assertion-mismatch",
    matcher: "toHaveText",
    negated: false,
  });
  expect(details).toContainEqual({
    basis: "error-message-signature",
    kind: "assertion-mismatch",
    matcher: "toBe",
    negated: false,
  });
  expect(details).toContainEqual({
    basis: "error-message-signature",
    kind: "locator-ambiguous",
    operation: "locator.click",
  });
  expect(details).toContainEqual({
    basis: "error-message-signature",
    kind: "navigation-network",
    operation: "page.goto",
    network: "connection-refused",
  });
});
