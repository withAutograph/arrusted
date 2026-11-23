#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { deparse, parse } from "@libpg-query/parser";

type Statement = { stmt: Record<string, unknown> };

export async function createAuthMigrationArtifact(
  sourceSha: string,
  pullRequest: number,
  baseSchema: string,
  candidateSchema: string,
): Promise<{ metadata: Record<string, string | number>; sql: string }> {
  if (!/^[a-f0-9]{40}$/iu.test(sourceSha) || !Number.isSafeInteger(pullRequest) || pullRequest < 1) {
    throw new Error("Auth migration artifact source identity is invalid");
  }
  const base = await parse(baseSchema);
  const candidate = await parse(candidateSchema);
  const baseByIdentity = new Map(base.stmts.map((statement) => [identity(statement as Statement), canonical(statement)]));
  const additions = [];
  for (const statement of candidate.stmts) {
    const candidateStatement = statement as Statement;
    const key = identity(candidateStatement);
    const existing = baseByIdentity.get(key);
    if (existing === canonical(candidateStatement)) continue;
    if (existing !== undefined) {
      throw new Error(`Auth migration artifact changes existing ${key}; use an expand/contract migration`);
    }
    assertAdditiveStatement(candidateStatement);
    additions.push(await deparse({ version: candidate.version, stmts: [statement] }));
  }
  // Each deparsed statement has no terminator; join them as one script.
  const sql = additions.map((statement) => `${statement};\n`).join("");
  return {
    metadata: {
      version: 1,
      pullRequest,
      sourceSha: sourceSha.toLowerCase(),
      sha256: createHash("sha256").update(sql).digest("hex"),
    },
    sql,
  };
}

function identity(statement: Statement): string {
  const node = statement.stmt;
  const create = node.CreateStmt as { relation?: { relname?: string } } | undefined;
  if (create?.relation?.relname) return `table:${create.relation.relname}`;
  const index = node.IndexStmt as { idxname?: string; relation?: { relname?: string } } | undefined;
  if (index?.idxname && index.relation?.relname) return `index:${index.relation.relname}:${index.idxname}`;
  return `statement:${canonical(statement)}`;
}

function assertAdditiveStatement(statement: Statement): void {
  if (!("CreateStmt" in statement.stmt || "IndexStmt" in statement.stmt)) {
    throw new Error("Auth migration artifact permits only new tables and indexes");
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([key]) => key !== "location" && key !== "stmt_len" && key !== "stmt_location")
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`)
    .join(",")}}`;
}

if (import.meta.main) {
  const [sourceSha, pullRequestText, basePath, candidatePath, outputPath] = process.argv.slice(2);
  if (!sourceSha || !pullRequestText || !basePath || !candidatePath || !outputPath) {
    throw new Error("usage: generate-auth-migration-artifact <sha> <pr> <base-schema> <candidate-schema> <output-dir>");
  }
  const artifact = await createAuthMigrationArtifact(
    sourceSha,
    Number(pullRequestText),
    await readFile(basePath, "utf8"),
    await readFile(candidatePath, "utf8"),
  );
  await mkdir(outputPath, { recursive: true });
  await Promise.all([
    writeFile(join(outputPath, "auth-migration-plan.json"), `${JSON.stringify(artifact.metadata)}\n`),
    writeFile(join(outputPath, "auth-migration-plan.sql"), artifact.sql),
  ]);
}
