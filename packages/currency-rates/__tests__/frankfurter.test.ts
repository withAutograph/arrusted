import { expect, test, vi } from "vite-plus/test";
import { fetchFrankfurterMonthlyRate } from "../frankfurter";
const request = { sourceCurrency: "EUR", targetCurrency: "USD", month: "2026-08" };
function transport(body: string, status = 200) {
  return vi.fn<typeof fetch>().mockResolvedValue(new Response(body, { status }));
}
test("requests one first-of-month observation, preserves decimals, and leaves its end open", async () => {
  const fetch = transport(
    '{"base":"EUR","quote":"USD","date":"2026-07-31","rate":1.1234567890123456789012345678}',
  );
  const rate = await fetchFrankfurterMonthlyRate(request, { fetch, today: "2026-08-15" });
  expect(String(fetch.mock.calls[0]![0])).toBe(
    "https://api.frankfurter.dev/v2/rate/EUR/USD?date=2026-08-01",
  );
  expect(rate).toEqual({
    sourceCurrency: "EUR",
    targetCurrency: "USD",
    rate: "1.1234567890123456789012345678",
    effectiveStart: "2026-08-01",
    effectiveEnd: null,
    origin: "frankfurter",
    observationDate: "2026-07-31",
  });
});
test("normalizes small scientific observations without float arithmetic", async () => {
  const fetch = transport('{"base":"EUR","quote":"USD","date":"2026-08-01","rate":1.23e-7}');
  expect((await fetchFrankfurterMonthlyRate(request, { fetch, today: "2026-08-15" }))?.rate).toBe(
    "0.000000123",
  );
});
test("unsupported pairs are missing, transport failures remain errors", async () => {
  expect(
    await fetchFrankfurterMonthlyRate(request, {
      fetch: transport("{}", 404),
      today: "2026-08-15",
    }),
  ).toBeNull();
  await expect(
    fetchFrankfurterMonthlyRate(request, { fetch: transport("{}", 503), today: "2026-08-15" }),
  ).rejects.toThrow("503");
});
test("does not invent future observations or fetch identity rates", async () => {
  const fetch = transport("{}");
  await expect(
    fetchFrankfurterMonthlyRate(request, { fetch, today: "2026-07-31" }),
  ).rejects.toThrow("future");
  expect(
    await fetchFrankfurterMonthlyRate(
      { ...request, targetCurrency: "EUR" },
      { fetch, today: "2026-08-15" },
    ),
  ).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});
test.each([
  '{"base":"GBP","quote":"USD","date":"2026-08-01","rate":1.2}',
  '{"base":"EUR","quote":"USD","date":"2026-08-02","rate":1.2}',
  '{"base":"EUR","quote":"USD","date":"2026-08-01","rate":0}',
  '{"base":"EUR","quote":"USD","date":"2026-02-30","rate":1.2}',
])("rejects malformed or mismatched provider data: %s", async (body) => {
  await expect(
    fetchFrankfurterMonthlyRate(request, { fetch: transport(body), today: "2026-08-15" }),
  ).rejects.toThrow();
});
