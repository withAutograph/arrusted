import { describe, expect, test } from "vite-plus/test";
import { createLabelIndex } from "@autograph/work-session-tools/labels";
import { recordsAffected, stagedImpact, sumDecimals } from "../impact";
import { impactDifference, impactLine } from "../impact-strip";
import { definition, ids, money, num, text } from "./fixture";

const labels = createLabelIndex(definition);
type Value = Parameters<typeof stagedImpact>[1][number]["value"];
const entry = (record_id: string, field_id: string, baseline: Value, value: Value) => ({
  model_id: "m_person",
  record_id,
  field_id,
  baseline,
  value,
});
const team = (value: string) => ({ type: "enum" as const, value });

describe("impact", () => {
  test("records affected counts distinct records across staged entries", () => {
    expect(
      recordsAffected([
        entry(ids.ada, "f_pay", null, null),
        entry(ids.ada, "f_score", null, null),
        entry(ids.bo, "f_pay", null, null),
      ]),
    ).toBe(2);
  });

  test("money totals before and after over the changed records, never across currencies or periods", () => {
    expect(
      stagedImpact(labels, [
        entry(ids.ada, "f_pay", money("100000"), money("120000")),
        entry(ids.bo, "f_pay", money("90000.50"), money("95000")),
        entry(ids.cy, "f_pay", money("40", "EUR", "monthly"), money("45", "EUR", "monthly")),
      ]),
    ).toEqual([
      {
        model_id: "m_person",
        field_id: "f_pay",
        count: 3,
        kind: "totals",
        totals: [
          { unit: { currency: "EUR", period: "monthly" }, before: "40", after: "45", records: 1 },
          {
            unit: { currency: "USD", period: "annual" },
            before: "190000.5",
            after: "215000",
            records: 2,
          },
        ],
        unitMoves: [],
      },
    ]);
  });

  test("a change of currency or period is a move, not a drop in one total and a rise in another", () => {
    const [pay] = stagedImpact(labels, [
      entry(ids.ada, "f_pay", money("100000"), money("90000", "EUR", "monthly")),
      entry(ids.bo, "f_pay", money("90000"), money("95000")),
    ]);
    expect(pay).toMatchObject({
      kind: "totals",
      totals: [
        {
          unit: { currency: "USD", period: "annual" },
          before: "90000",
          after: "95000",
          records: 1,
        },
      ],
      unitMoves: [
        {
          from: { currency: "USD", period: "annual" },
          to: { currency: "EUR", period: "monthly" },
          count: 1,
        },
      ],
    });
    expect(impactLine({ labels } as never, undefined, pay!)).toEqual([
      "$90,000 → $95,000 (+$5,000) over 1 changed record",
      "1 record USD annual → EUR monthly",
    ]);
  });

  test("gone entries, which Save drops, count toward neither records nor totals", () => {
    const gone = {
      ...entry(ids.cy, "f_score", num("1"), num("100")),
      gone: "record_gone" as const,
    };
    expect(recordsAffected([entry(ids.ada, "f_score", null, null), gone])).toBe(1);
    expect(stagedImpact(labels, [entry(ids.ada, "f_score", num("3"), num("4")), gone])).toEqual([
      {
        model_id: "m_person",
        field_id: "f_score",
        count: 1,
        kind: "totals",
        totals: [{ unit: null, before: "3", after: "4", records: 1 }],
        unitMoves: [],
      },
    ]);
  });

  test("number totals; an empty value adds nothing", () => {
    const [score] = stagedImpact(labels, [
      entry(ids.ada, "f_score", num("3"), num("4.5")),
      entry(ids.bo, "f_score", null, num("2")),
    ]);
    expect(score).toMatchObject({
      kind: "totals",
      totals: [{ unit: null, before: "3", after: "6.5", records: 2 }],
    });
  });

  test("choice columns group records by from → to, most moved first", () => {
    const [moved] = stagedImpact(labels, [
      entry(ids.ada, "f_team", team("ops"), team("eng")),
      entry(ids.bo, "f_team", team("eng"), team("ops")),
      entry(ids.cy, "f_team", team("eng"), team("ops")),
    ]);
    expect(moved).toMatchObject({
      kind: "moves",
      moves: [
        { from: team("eng"), to: team("ops"), count: 2 },
        { from: team("ops"), to: team("eng"), count: 1 },
      ],
    });
  });

  test("other columns count their changes", () => {
    expect(
      stagedImpact(labels, [
        entry(ids.ada, "f_name", text("Ada"), text("Ada L.")),
        entry(ids.bo, "f_name", text("Bo"), text("Bo K.")),
      ]),
    ).toEqual([{ model_id: "m_person", field_id: "f_name", count: 2, kind: "changes" }]);
  });

  test("decimals sum exactly", () => {
    expect(sumDecimals(["0.1", "0.2"])).toBe("0.3");
    expect(sumDecimals(["-5", "2.25"])).toBe("-2.75");
    expect(sumDecimals([])).toBe("0");
  });
});

describe("impactDifference", () => {
  const unit = { currency: "USD", period: "annual" };
  const total = (after: string, before: string) => ({ after, before, unit });
  test("a difference that rounds away shows as none, never +$0", () => {
    expect(impactDifference(total("100.40", "100"))).toBe("0");
    expect(impactDifference(total("100", "100.40"))).toBe("0");
    expect(impactDifference(total("120000", "100000"))).toBe("+$20,000");
    expect(impactDifference(total("100000", "120000"))).toBe("−$20,000");
    expect(impactDifference({ after: "7", before: "4", unit: null })).toBe("+3");
  });
});
