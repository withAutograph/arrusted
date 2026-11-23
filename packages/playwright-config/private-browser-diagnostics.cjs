const { stripVTControlCharacters } = require("node:util");

const stages = new Set([
  "recording-policy",
  "fixture-scope",
  "preview-bootstrap",
  "preview-refresh-required",
  "signed-out-session",
  "auth-ui",
  "auth-session",
  "fixture-recheck",
  "protected-operation",
  "context-cleanup",
  "readback-runtime-unavailable",
  "readback-actor-not-authorized",
  "readback-scope-closed",
  "readback-release-unavailable",
  "readback-unavailable",
]);

const errors = new WeakMap();
const loginDiagnosticMessage = (stage) =>
  `Normal actor UI login failed; private diagnostics are withheld. [stage: ${stages.has(stage) ? stage : "protected-operation"}]`;
const readbackDiagnosticMessage = (code) => `Normal actor readback failed (${code}).`;

const previewDiagnosticMessage =
  "Private preview browser access needs a current owner-bound preview at the exact Auth origin, with private tracing disabled and the bounded private reporter. Refresh the preview through Builder; do not change application authorization.";

function markPrivateBrowserError(error, stage) {
  if (stages.has(stage)) errors.set(error, stage);
}

const privateBrowserErrorStage = (error) => errors.get(error);

const messages = new Map();
for (const stage of stages) {
  const login = loginDiagnosticMessage(stage);
  messages.set(login, stage);
  messages.set(`NormalActorUiLoginError: ${login}`, stage);
  if (stage.startsWith("readback-")) {
    const code =
      stage === "readback-unavailable"
        ? "readback_unavailable"
        : stage.slice("readback-".length).replaceAll("-", "_");
    const readback = readbackDiagnosticMessage(code);
    messages.set(readback, stage);
    messages.set(`NormalActorReadbackError: ${readback}`, stage);
  }
}

const privateBrowserDiagnosticStage = (message) => messages.get(message);

// Classify recognized Playwright failures without retaining any application values or URLs.
const privateBrowserDiagnosticCategory = (message) => {
  if (typeof message !== "string") return undefined;
  const plain = stripVTControlCharacters(message);
  if (/^(?:Error: )?browserType\.launch(?:PersistentContext)?:/u.test(plain)) {
    return "browser-launch";
  }
  if (/^(?:Error: )?(?:page|frame)\.(?:goto|waitForURL):/u.test(plain)) {
    return "navigation";
  }
  if (/^(?:Error: )?expect\(/u.test(plain)) return "assertion";
  if (
    /^(?:Error: )?(?:(?:locator|page|frame)\.[A-Za-z]+: Timeout \d+ms exceeded\b|Test timeout of \d+ms exceeded|TimeoutError:|Timed out \d+ms waiting for)/u.test(
      plain,
    )
  ) {
    return "timeout";
  }
  return undefined;
};

const matchers = new Map(
  [
    "toBeVisible",
    "toBeHidden",
    "toHaveText",
    "toContainText",
    "toHaveCount",
    "toHaveValue",
    "toHaveValues",
    "toBeEnabled",
    "toBeDisabled",
    "toBeEditable",
    "toBeChecked",
    "toBeAttached",
    "toBeFocused",
    "toHaveAttribute",
    "toHaveClass",
    "toHaveCSS",
    "toHaveId",
    "toHaveJSProperty",
    "toHaveAccessibleName",
    "toHaveRole",
    "toHaveURL",
    "toHaveTitle",
    "toBe",
    "toEqual",
    "toStrictEqual",
    "toMatchObject",
    "toContain",
    "toContainEqual",
    "toBeTruthy",
    "toBeFalsy",
    "toBeNull",
    "toBeDefined",
    "toBeUndefined",
    "toMatch",
    "toHaveLength",
    "toBeGreaterThan",
    "toBeLessThan",
    "toBeGreaterThanOrEqual",
    "toBeLessThanOrEqual",
    "toBeCloseTo",
    "toThrow",
  ].map((matcher) => [matcher, matcher]),
);
const navigationMethods = ["goto", "waitForURL", "reload", "goBack", "goForward"];
const operations = new Map(
  [
    ...[
      "click",
      "dblclick",
      "fill",
      "check",
      "uncheck",
      "setChecked",
      "selectOption",
      "press",
      "pressSequentially",
      "type",
      "hover",
      "focus",
      "blur",
      "tap",
      "waitFor",
      "dragTo",
      "dispatchEvent",
    ].map((method) => `locator.${method}`),
    ...["page", "frame"].flatMap((target) =>
      navigationMethods.map((method) => `${target}.${method}`),
    ),
  ].map((operation) => [operation, operation]),
);
const networkFailures = new Map([
  ["ERR_CONNECTION_REFUSED", "connection-refused"],
  ["ERR_NAME_NOT_RESOLVED", "dns-failure"],
  ["ERR_CERT_AUTHORITY_INVALID", "tls-failure"],
  ["ERR_CERT_COMMON_NAME_INVALID", "tls-failure"],
  ["ERR_CERT_DATE_INVALID", "tls-failure"],
  ["ERR_CONNECTION_RESET", "connection-reset"],
  ["ERR_ABORTED", "aborted"],
  ["ERR_HTTP_RESPONSE_CODE_FAILURE", "http-response-error"],
]);

/** Return only fixed failure facts; no captured error text or application values escape. */
const privateBrowserFailureDetail = (message) => {
  if (typeof message !== "string") return undefined;
  const plain = stripVTControlCharacters(message);
  const assertion = /^(?:Error: )?expect\((locator|page|received)\)(\.not)?\.([A-Za-z]+)\(/u.exec(
    plain,
  );
  if (assertion) {
    const matcher = matchers.get(assertion[3]);
    if (matcher === undefined) return undefined;
    const negated = assertion[2] !== undefined;
    if (assertion[1] === "locator") {
      if (
        /\n(?:Error: element\(s\) not found|Received: <element\(s\) not found>)(?:\r?\n|$)/u.test(
          plain,
        )
      ) {
        return { kind: "locator-not-found", matcher, negated };
      }
      if (/\nError: strict mode violation: /u.test(plain)) {
        return { kind: "locator-ambiguous", matcher, negated };
      }
    }
    return { kind: "assertion-mismatch", matcher, negated };
  }

  const action = /^(?:Error: )?((?:locator|page|frame)\.[A-Za-z]+): (.*)/u.exec(plain);
  if (!action) return undefined;
  const operation = operations.get(action[1]);
  if (operation === undefined) return undefined;
  const isNavigation = !operation.startsWith("locator.");
  if (/^(?:Error: )?strict mode violation: /u.test(action[2]) && !isNavigation) {
    return { kind: "locator-ambiguous", operation };
  }
  if (/^Timeout \d+ms exceeded\b/u.test(action[2])) {
    return { kind: isNavigation ? "navigation-timeout" : "action-timeout", operation };
  }
  if (isNavigation) {
    const failure = /^net::(ERR_[A-Z_]+)(?: at |$)/u.exec(action[2]);
    const network = failure && networkFailures.get(failure[1]);
    if (network !== undefined && network !== null) {
      return {
        kind: network === "http-response-error" ? "navigation-http-response" : "navigation-network",
        operation,
        network,
      };
    }
  }
  return undefined;
};

module.exports = {
  loginDiagnosticMessage,
  markPrivateBrowserError,
  previewDiagnosticMessage,
  privateBrowserDiagnosticCategory,
  privateBrowserDiagnosticStage,
  privateBrowserErrorStage,
  privateBrowserFailureDetail,
  readbackDiagnosticMessage,
};
