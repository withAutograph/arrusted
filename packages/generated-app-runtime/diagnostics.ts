import { readFileSync } from "node:fs";
import path from "node:path";

type CueOrigin = {
  source: string;
  path: string;
  kind: "app" | "model" | "field" | "constraint" | "migration";
};
type CheckedSourceMap = {
  sql_artifacts?: Array<{ kind: string; name: string; origin?: CueOrigin }>;
  migrations?: Array<{ version: string; origin?: CueOrigin }>;
};

/** Trusted, operator-facing normalization of generated SQL diagnostics.
 * It retains canonical machine codes but deliberately omits PostgreSQL message,
 * table, and constraint text so callers cannot accidentally return internals.
 */
export type GeneratedDiagnostic = {
  code: string;
  origin?: CueOrigin;
};

export function resolveGeneratedDiagnostic(
  releaseDirectory: string,
  failure: { code?: unknown; details?: unknown },
): GeneratedDiagnostic | undefined {
  if (!failure || typeof failure.code !== "string") return undefined;
  const sourceMap = JSON.parse(
    readFileSync(path.join(releaseDirectory, "cue-to-sql-source-map.json"), "utf8"),
  ) as CheckedSourceMap;
  const details = Array.isArray(failure.details) ? failure.details : [];
  const values = details.flatMap((detail) =>
    detail &&
    typeof detail === "object" &&
    typeof (detail as { message?: unknown }).message === "string"
      ? [(detail as { message: string }).message]
      : [],
  );
  const artifact = sourceMap.sql_artifacts?.find((candidate) =>
    values.some((value) => candidate.name === value || candidate.name.endsWith(`.${value}`)),
  );
  const origin =
    artifact?.origin ??
    sourceMap.sql_artifacts?.find((candidate) =>
      values.some(
        (value) =>
          candidate.origin?.path === `constraints.${value}.expression` ||
          candidate.origin?.path === `models.${value}`,
      ),
    )?.origin;
  return origin ? { code: failure.code, origin } : { code: failure.code };
}
