import path from "node:path";
import diagnostics from "./private-browser-diagnostics.cjs";

const {
  previewDiagnosticMessage,
  privateBrowserDiagnosticCategory,
  privateBrowserDiagnosticStage,
  privateBrowserFailureDetail,
} = diagnostics;

const reportCategories = (messages, timedOut = false) => {
  const categories = new Set(messages.map(privateBrowserDiagnosticCategory));
  if (timedOut) categories.add("timeout");
  for (const category of categories) {
    if (category !== undefined) process.stdout.write(`[private browser category] ${category}\n`);
  }
};

// Serialized application errors can mimic these signatures; verify each clue against the app/test.
const reportFailureDetails = (messages) => {
  const details = new Set(
    messages
      .map(privateBrowserFailureDetail)
      .filter((detail) => detail !== undefined)
      .map((detail) => JSON.stringify({ basis: "error-message-signature", ...detail })),
  );
  for (const detail of details) {
    process.stdout.write(`[private browser diagnostic] ${detail}\n`);
  }
};

/** Private tests retain inferred failure clues, never API steps, raw errors or worker output. */
export default class PrivatePreviewReporter {
  onTestEnd(test, result) {
    const title = test
      .titlePath()
      .join(" > ")
      .replaceAll(/https?:\/\/[^\s]+/gu, "[URL REDACTED]")
      .replaceAll(/\p{Cc}/gu, " ")
      .slice(0, 240);
    const file = path.relative(process.cwd(), test.location.file);
    const location =
      file && !file.startsWith("..") && !path.isAbsolute(file) && /^[a-zA-Z0-9_./-]+$/u.test(file)
        ? ` (${file}:${test.location.line})`
        : "";
    const errors = result.errors ?? [];
    const messages = errors.map((error) => error.message);
    reportCategories(messages, result.status === "timedOut");
    reportFailureDetails(messages);
    const failureLines = new Set(
      errors
        .map((error) => error.location)
        .filter((frame) => frame?.file === test.location.file)
        .map((frame) => frame.line)
        .filter((line) => Number.isSafeInteger(line) && line > 0),
    );
    if (location) {
      for (const line of [...failureLines].slice(0, 4)) {
        process.stdout.write(`[private browser failure] ${file}:${line}\n`);
      }
    }
    const stages = new Set(messages.map(privateBrowserDiagnosticStage));
    if (
      messages.some(
        (message) =>
          message === previewDiagnosticMessage ||
          message === `PrivatePreviewBrowserAccessError: ${previewDiagnosticMessage}`,
      )
    ) {
      process.stdout.write("[private browser prerequisite] private-preview-refresh-required\n");
    }
    for (const stage of stages) {
      if (stage !== undefined) process.stdout.write(`[private browser stage] ${stage}\n`);
    }
    process.stdout.write(
      `[private browser] ${result.status}: ${title}${location}${result.status === "failed" ? " [application-test-failure; raw diagnostics withheld]" : ""}\n`,
    );
  }
  onError(error) {
    reportCategories([error.message]);
    reportFailureDetails([error.message]);
    process.stdout.write(
      "[private browser] failed: [application-test-failure; raw diagnostics withheld]\n",
    );
  }
  onEnd(result) {
    process.stdout.write(`[private browser] run ${result.status}\n`);
  }
}
