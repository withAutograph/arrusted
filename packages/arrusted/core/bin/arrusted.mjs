#!/usr/bin/env node
import { runCoreCli } from "../dist/cli.js";

runCoreCli().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
