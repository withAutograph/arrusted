#!/usr/bin/env node
import { runAuthCli } from "../dist/cli.js";

runAuthCli().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
