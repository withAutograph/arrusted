import type { FieldValue, RowVersionWrite, TenantScope, VisibleRecord } from "../contracts";
import type { CanonicalKernelOperations } from "../kernel-client/postgres";
import {
  currencyPairKey,
  validateCurrencyDate,
  validateCurrencyPair,
  validateCurrencyRate,
  type CurrencyRate,
  type CurrencyRateRequest,
} from "../engines/currency/rates";
import { fetchFrankfurterMonthlyRate } from "./frankfurter";

export { convertCurrency, resolveCurrencyRate } from "../engines/currency/rates";
export type {
  CurrencyRate,
  CurrencyRateRequest,
  CurrencyRateResolution,
  CurrencyConversion,
} from "../engines/currency/rates";

export type CustomRateInput = {
  sourceCurrency: string;
  targetCurrency: string;
  rate: string;
  effectiveStart: string;
  effectiveEnd: string | null;
  /** Existing finite boundary when correcting a period; omitted for a new period. */
  previousEffectiveEnd?: string | null;
};
type WriteOptions = { idempotencyKey: string; expectedVersionId?: string };

/** Bind only to a trusted, tenant-scoped server kernel client. This does not grant access. */
export function createCurrencyRateStore(input: {
  kernel: Pick<CanonicalKernelOperations, "readVisibleRecords" | "applyChangeSet">;
  scope: TenantScope;
  actorId: string;
}) {
  const { kernel, actorId } = input;
  const scope = { app_id: input.scope.appId, customer_id: input.scope.customerId };
  if (!scope.app_id || !scope.customer_id || !actorId)
    throw new Error("Currency rates require a trusted tenant and actor");
  function validateWriteOptions(options: WriteOptions) {
    if (!options.idempotencyKey.trim()) throw new Error("An idempotency key is required");
  }
  function apply(writes: RowVersionWrite[], options: WriteOptions, sourceKind: string) {
    validateWriteOptions(options);
    return kernel.applyChangeSet({
      ...scope,
      actor_id: actorId,
      source_kind: sourceKind,
      idempotency_key: options.idempotencyKey,
      mode: "mainline",
      writes: writes.map((write, index) => ({
        ...write,
        // A correction guard belongs to the period being corrected. Boundary
        // writes in the same atomic change set are derived from that correction.
        ...(index === 0 && options.expectedVersionId
          ? { expected_version_id: options.expectedVersionId }
          : {}),
      })),
    });
  }
  return {
    /** Reads kernel-selected versions. No network calls or cached conversion results. */
    async read(request: CurrencyRateRequest): Promise<CurrencyRate[]> {
      validateCurrencyPair(request.sourceCurrency, request.targetCurrency);
      validateCurrencyDate(request.asOf);
      if (request.sourceCurrency === request.targetCurrency) return [];
      const rows = await kernel.readVisibleRecords({
        ...scope,
        model_id: "exchange_rate",
        as_of: request.asOf,
      });
      return rows.flatMap((row) => {
        if (!matchesPair(row, request)) return [];
        const rate = decodeRate(row);
        return rate &&
          currencyPairKey(rate) === currencyPairKey(request) &&
          rate.effectiveStart <= request.asOf &&
          (rate.effectiveEnd === null || rate.effectiveEnd >= request.asOf)
          ? [rate]
          : [];
      });
    },
    /** Live effective history of this store's open-ended identities, not deleted-record audit history. */
    async history(
      pair: Pick<CurrencyRateRequest, "sourceCurrency" | "targetCurrency">,
    ): Promise<CurrencyRate[]> {
      validateCurrencyPair(pair.sourceCurrency, pair.targetCurrency);
      if (pair.sourceCurrency === pair.targetCurrency) return [];
      let cursor = "9999-12-31";
      let recordIds: string[] | undefined;
      const periods: CurrencyRate[] = [];
      const seen = new Set<string>();
      while (true) {
        const rows = await kernel.readVisibleRecords({
          ...scope,
          model_id: "exchange_rate",
          as_of: cursor,
          ...(recordIds ? { record_ids: recordIds } : {}),
        });
        let latestStart: string | undefined;
        for (const row of rows) {
          if (!matchesPair(row, pair)) continue;
          validateCurrencyDate(row.effective_start);
          if (row.effective_start < "0001-01-01" || row.effective_start > cursor)
            throw new Error("Invalid persisted exchange rate period");
          if (row.effective_end != null) {
            validateCurrencyDate(row.effective_end);
            if (row.effective_end < cursor)
              throw new Error("Invalid persisted exchange rate period");
          }
          // Empty custom versions also mark a boundary: returning to automatic must not hide earlier rates.
          if (!latestStart || row.effective_start > latestStart) latestStart = row.effective_start;
          const rate = decodeRate(row);
          const identity = row.version_id ?? `${row.record_id}/${row.effective_start}`;
          if (rate && !seen.has(identity)) {
            seen.add(identity);
            periods.push(rate);
          }
        }
        if (!recordIds) {
          recordIds = [
            ...new Set(rows.filter((row) => matchesPair(row, pair)).map((row) => row.record_id)),
          ];
        }
        if (!latestStart || latestStart === "0001-01-01") break;
        const previous = new Date(`${latestStart}T00:00:00.000Z`);
        previous.setUTCDate(previous.getUTCDate() - 1);
        cursor = previous.toISOString().slice(0, 10);
      }
      return periods.sort(
        (left, right) =>
          right.effectiveStart.localeCompare(left.effectiveStart) ||
          left.origin.localeCompare(right.origin),
      );
    },
    saveCustom(rate: CustomRateInput, options: WriteOptions) {
      validateCurrencyRate({ ...rate, origin: "custom" });
      if (rate.sourceCurrency === rate.targetCurrency)
        throw new Error("Same-currency conversion always uses 1");
      if (rate.previousEffectiveEnd !== undefined && rate.previousEffectiveEnd !== null) {
        validateCurrencyDate(rate.previousEffectiveEnd);
        if (rate.previousEffectiveEnd < rate.effectiveStart)
          throw new Error("Previous currency rate ends before it starts");
      }
      const custom = { ...rate, origin: "custom" as const };
      const writes = [rateWrite(custom)];
      if (
        rate.previousEffectiveEnd &&
        (rate.effectiveEnd === null || rate.effectiveEnd > rate.previousEffectiveEnd)
      ) {
        writes.push(rateWrite({ ...custom, effectiveStart: dayAfter(rate.previousEffectiveEnd) }));
      }
      if (rate.effectiveEnd !== null) {
        writes.push(automaticBoundary(rate, dayAfter(rate.effectiveEnd)));
      }
      return apply(writes, options, "human");
    },
    useAutomatic(rate: Omit<CustomRateInput, "rate" | "effectiveEnd">, options: WriteOptions) {
      validateCurrencyPair(rate.sourceCurrency, rate.targetCurrency);
      validateCurrencyDate(rate.effectiveStart);
      if (rate.sourceCurrency === rate.targetCurrency)
        throw new Error("Same-currency conversion always uses 1");
      return apply([automaticBoundary(rate, rate.effectiveStart)], options, "human");
    },
    /** Explicit host-invoked preparation, once per needed pair/month; never invoked by read. */
    async importMonthly(
      request: { sourceCurrency: string; targetCurrency: string; month: string },
      options: WriteOptions & { fetch?: typeof fetch; today?: string; signal?: AbortSignal },
    ) {
      validateCurrencyPair(request.sourceCurrency, request.targetCurrency);
      validateWriteOptions(options);
      const [sourceCurrency, targetCurrency] = currencyPairKey(request).split("/");
      const rate = await fetchFrankfurterMonthlyRate(
        { ...request, sourceCurrency: sourceCurrency!, targetCurrency: targetCurrency! },
        options,
      );
      if (!rate) return { status: "unavailable" as const };
      // Host-requested public rate preparation uses the ordinary import path.
      // Connected-account ingestion reserves "integration" for a provisioned service actor.
      const receipt = await apply([rateWrite(rate)], options, "data_import");
      return { status: "imported" as const, rate, receipt };
    },
  };
}

function matchesPair(
  row: VisibleRecord,
  pair: Pick<CurrencyRateRequest, "sourceCurrency" | "targetCurrency">,
): boolean {
  const source = row.values.source_currency?.value;
  const target = row.values.target_currency?.value;
  return (
    (source === pair.sourceCurrency && target === pair.targetCurrency) ||
    (source === pair.targetCurrency && target === pair.sourceCurrency)
  );
}

function rateWrite(rate: CurrencyRate): RowVersionWrite {
  const key = `${currencyPairKey(rate)}/${rate.origin}`;
  const values: Record<string, FieldValue> = {
    source_currency: { type: "text", value: rate.sourceCurrency },
    target_currency: { type: "text", value: rate.targetCurrency },
    origin: { type: "enum", value: rate.origin },
    rate: { type: "number", value: rate.rate },
  };
  const clear = ["observation_date"];
  if (rate.observationDate) {
    values.observation_date = { type: "date", value: rate.observationDate };
    clear.splice(clear.indexOf("observation_date"), 1);
  }
  return {
    model_id: "exchange_rate",
    record_key: { type: "external_key", value: key },
    effective_start: rate.effectiveStart,
    values,
    clear_fields: clear,
    provenance: {
      source: rate.origin,
      ...(rate.observationDate ? { observation_date: rate.observationDate } : {}),
    },
  };
}

function automaticBoundary(
  pair: Pick<CustomRateInput, "sourceCurrency" | "targetCurrency">,
  effectiveStart: string,
): RowVersionWrite {
  const write = rateWrite({
    ...pair,
    rate: "1",
    effectiveStart,
    effectiveEnd: null,
    origin: "custom",
  });
  delete write.values!.rate;
  write.clear_fields = ["rate", "observation_date"];
  return write;
}

function dayAfter(value: string): string {
  validateCurrencyDate(value);
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  const result = date.toISOString().slice(0, 10);
  validateCurrencyDate(result);
  if (result <= value) throw new Error("Currency rate end is outside the supported date range");
  return result;
}

function decodeRate(row: VisibleRecord): CurrencyRate | null {
  function value(name: string, type: FieldValue["type"], optional = false): string | undefined {
    const field = row.values[name];
    if (field === undefined && optional) return undefined;
    if (!field || field.type !== type || typeof field.value !== "string")
      throw new Error(`Invalid persisted exchange rate ${name}`);
    return field.value;
  }
  const origin = value("origin", "enum");
  if (origin !== "custom" && origin !== "frankfurter")
    throw new Error("Invalid persisted exchange rate origin");
  const amount = value("rate", "number", origin === "custom");
  if (amount === undefined) return null;
  const versionEnd = row.effective_end ?? null;
  const rate: CurrencyRate = {
    sourceCurrency: value("source_currency", "text")!,
    targetCurrency: value("target_currency", "text")!,
    origin,
    rate: amount,
    ...(row.version_id ? { versionId: row.version_id } : {}),
    effectiveStart: row.effective_start,
    effectiveEnd: versionEnd,
    ...(row.values.observation_date ? { observationDate: value("observation_date", "date")! } : {}),
  };
  validateCurrencyRate(rate);
  const key = `${currencyPairKey(rate)}/${origin}`;
  if (row.external_key !== key) throw new Error("Invalid exchange rate identity");
  return rate;
}
