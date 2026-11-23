import {
  runProtectedGeneratedAppInstaller,
  runProtectedGeneratedAppAccess,
} from "./protected-installer";
import { runProtectedGeneratedAppExport } from "./protected-export-worker";

type WorkerArguments = {
  command: "install" | "access";
  readbackOnly: boolean;
  readbackKind?: "install";
  spoolDirectory: string;
  runId: string;
  timeoutMs: number;
  releaseDirectory: string;
};

function parseArguments(args: string[]): WorkerArguments {
  if (
    args.length !== 7 ||
    ![
      "protected-generated-app-install",
      "protected-generated-app-access",
      "protected-generated-app-access-readback",
      "protected-generated-app-install-readback",
    ].includes(args[0] ?? "") ||
    args[1] !== "--file-spool" ||
    args[5] !== "--release-directory" ||
    !/^[A-Za-z0-9_-]{1,128}$/u.test(args[3] ?? "") ||
    !/^[1-9][0-9]*$/u.test(args[4] ?? "")
  )
    throw new Error("protected_installer_cli_invalid");
  const timeoutMs = Number(args[4]);
  if (!Number.isSafeInteger(timeoutMs)) throw new Error("protected_installer_cli_invalid");
  return {
    command: args[0] === "protected-generated-app-install" ? "install" : "access",
    readbackOnly: args[0]?.endsWith("-readback") === true,
    ...(args[0] === "protected-generated-app-install-readback"
      ? { readbackKind: "install" as const }
      : {}),
    spoolDirectory: args[2]!,
    runId: args[3]!,
    timeoutMs,
    releaseDirectory: args[6]!,
  };
}

async function main(): Promise<void> {
  if (process.argv[2] === "protected-generated-app-export") {
    await runProtectedGeneratedAppExport();
    return;
  }
  try {
    const input = parseArguments(process.argv.slice(2));
    if (input.command === "access") await runProtectedGeneratedAppAccess(input);
    else await runProtectedGeneratedAppInstaller(input);
  } catch {
    process.stderr.write("protected_generated_app_install_failed\n");
    process.exitCode = 1;
  }
}

if (import.meta.main) await main();
