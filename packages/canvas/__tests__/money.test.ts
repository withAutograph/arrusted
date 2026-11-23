import { describe, expect, test } from "vite-plus/test";

import { formatNumber } from "../money";
import { groupDigits } from "../review-labels";

describe("formatNumber", () => {
  test("rounds a derived quotient to four decimals, exactly from its string", () => {
    expect(formatNumber("1.0535714285714285714285714286")).toBe("1.0536");
    expect(formatNumber("0.9999999999999999999999999999")).toBe("1");
  });

  test("leaves short numbers as entered, grouped", () => {
    expect(formatNumber("82")).toBe("82");
    expect(formatNumber("1.125")).toBe("1.125");
    expect(formatNumber("-1234567.5")).toBe("-1,234,567.5");
    expect(formatNumber(30)).toBe("30");
  });

  test("passes anything that is not a decimal through", () => {
    expect(formatNumber("n/a")).toBe("n/a");
    expect(formatNumber(Number.NaN)).toBe("NaN");
  });
});

describe("the change log's numbers", () => {
  test("keep every digit, so an edit past the fourth decimal still reads as a change", () => {
    expect(groupDigits("1.00001")).toBe("1.00001");
    expect(groupDigits("1")).toBe("1");
  });
});
