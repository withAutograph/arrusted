import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import {
  exportProtectedTenant,
  tenantExportCredentialEnvironment,
  tenantExportInputPath,
  tenantExportInputRoot,
} from "./protected-export";
import { tenantExportWorkerInputSchema } from "./protected-export-contract";

/** Fixed metadata input; the file option is server-owned, nonsecret metadata only. */
export async function runProtectedGeneratedAppExport(): Promise<void> {
  try {
    const args = process.argv.slice(2);
    if (args[0] !== "protected-generated-app-export" || ![1, 3].includes(args.length))
      throw new Error("tenant_export_cli_invalid");
    let metadataFile: Awaited<ReturnType<typeof open>> | undefined;
    if (args.length === 3) {
      const uuid = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
      if (
        args[1] !== "--file-spool" ||
        !new RegExp(`^${tenantExportInputRoot}/${uuid}/${uuid}\\.json$`, "u").test(args[2]!)
      )
        throw new Error("tenant_export_cli_invalid");
      for (const directory of [tenantExportInputRoot, path.dirname(args[2]!)]) {
        const stat = await lstat(directory);
        if (
          !stat.isDirectory() ||
          (stat.mode & 0o777) !== 0o700 ||
          (process.getuid && stat.uid !== process.getuid())
        )
          throw new Error("tenant_export_input_invalid");
      }
      metadataFile = await open(args[2]!, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await metadataFile.stat();
      if (
        !stat.isFile() ||
        (stat.mode & 0o777) !== 0o600 ||
        (process.getuid && stat.uid !== process.getuid())
      ) {
        await metadataFile.close();
        throw new Error("tenant_export_input_invalid");
      }
    }
    const parts: Buffer[] = [];
    let length = 0;
    try {
      const source = metadataFile
        ? metadataFile.createReadStream({ autoClose: false })
        : process.stdin;
      for await (const part of source) {
        const bytes = Buffer.from(part);
        length += bytes.length;
        if (length > 1_048_576) throw new Error("tenant_export_metadata_invalid");
        parts.push(bytes);
      }
    } finally {
      await metadataFile?.close();
    }
    const input = tenantExportWorkerInputSchema.parse(
      JSON.parse(Buffer.concat(parts).toString("utf8")),
    );
    if (args.length === 3 && args[2] !== tenantExportInputPath(input))
      throw new Error("tenant_export_input_invalid");
    const credential = process.env[tenantExportCredentialEnvironment];
    if (!credential) throw new Error("tenant_export_credential_missing");
    // No child receives this command credential, and it is never written to disk.
    delete process.env[tenantExportCredentialEnvironment];
    const result = await exportProtectedTenant(input, credential);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch {
    process.stderr.write("tenant_export_failed\n");
    process.exitCode = 1;
  }
}

if (import.meta.main) await runProtectedGeneratedAppExport();
