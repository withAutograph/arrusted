import { copyFileSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const repositoryRoot = join(import.meta.dirname, "../../../..");
const root = mkdtempSync(join(tmpdir(), "runtime-ui-policy-"));

try {
  mkdirSync(join(root, "rules"), { recursive: true });
  mkdirSync(join(root, "packages/example"), { recursive: true });
  copyFileSync(
    join(
      repositoryRoot,
      ".config/mise/scripts/check/ast-grep/rules/calls/no-runtime-remote-ui.yml",
    ),
    join(root, "rules/no-runtime-remote-ui.yml"),
  );
  writeFileSync(join(root, "sgconfig.yml"), "ruleDirs:\n  - rules\n");
  writeFileSync(
    join(root, "packages/example/safe.tsx"),
    "export const Safe = ({ text }: { text: string }) => <main>{text}</main>;\n",
  );
  assertScan(root, 0, null);

  for (const source of [
    "export const Unsafe = ({ html }: { html: string }) => <main dangerouslySetInnerHTML={{ __html: html }} />;\n",
    "export const Unsafe = ({ html }: { html: string }) => <iframe srcDoc={html} />;\n",
    "export const Unsafe = ({ html }: { html: string }) => <iframe srcdoc={html} />;\n",
    "export const Unsafe = ({ source }: { source: string }) => <script>{source}</script>;\n",
    "export const Unsafe = ({ source }: { source: string }) => <Script>{source}</Script>;\n",
    'export const Unsafe = () => <link rel="stylesheet" href="/vendor/api/ui.css" />;\n',
    'export const Unsafe = () => <script src="/vendor/api/runtime.js" />;\n',
    "export function unsafe(node: Element, html: string) { node.outerHTML = html; }\n",
    'export function unsafe(node: Element, html: string) { node.insertAdjacentHTML("beforeend", html); }\n',
    "export function unsafe(html: string) { document.write(html); }\n",
    "export function unsafe(frame: HTMLIFrameElement, html: string) { frame.srcdoc = html; }\n",
    'export function unsafe() { return document.createElement("ScRiPt"); }\n',
    'export function unsafe() { return document.createElement("LINK"); }\n',
  ]) {
    const unsafePath = join(root, "packages/example/unsafe.tsx");
    writeFileSync(unsafePath, source);
    assertScan(
      root,
      1,
      "production app UI must not execute or inject runtime-provided code or HTML",
    );
    unlinkSync(unsafePath);
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

function assertScan(root: string, expectedExit: number, expectedDiagnostic: string | null): void {
  const astGrep = join(repositoryRoot, "node_modules", ".bin", "ast-grep");
  const result = Bun.spawnSync([astGrep, "scan", "--config", "sgconfig.yml"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = `${result.stdout.toString()}${result.stderr.toString()}`;
  if (result.exitCode !== expectedExit) {
    throw new Error(
      `runtime UI source policy expected exit ${expectedExit}, got ${result.exitCode}:\n${output}`,
    );
  }
  if (expectedDiagnostic !== null && !output.includes(expectedDiagnostic)) {
    throw new Error(`runtime UI source policy omitted expected diagnostic:\n${output}`);
  }
}
