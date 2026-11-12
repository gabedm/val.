import { describe, expect, it } from "vitest";
import { catalogueAmount, displayCurrencies, fxSnapshot } from "../src/client/catalogueCurrency";

describe("catalogue display estimates", () => {
  it("offers all five requested currencies from one dated ECB snapshot", () => {
    expect(displayCurrencies).toEqual(["USD", "GBP", "EUR", "JPY", "CNY"]);
    expect(fxSnapshot.date).toBe("2026-10-09");
  });
  it("cross-converts a USD offer to pounds without rounding the intermediate euro value", () => {
    expect(catalogueAmount(12, "USD", "GBP")).toEqual({
      converted: true,
      text: "≈ £9.08",
      original: "USD 12.00",
    });
  });
  it("keeps a same-currency listed price exact", () => {
    expect(catalogueAmount(12, "GBP", "GBP")).toEqual({
      converted: false,
      text: "£12.00",
      original: "GBP 12.00",
    });
  });
  it("rounds yen only for display and distinguishes yuan", () => {
    expect(catalogueAmount(1, "EUR", "JPY").text).toBe("≈ JP¥177");
    expect(catalogueAmount(1, "EUR", "CNY").text).toBe("≈ CN¥7.50");
  });
  it("retains Swedish offers and their original source amount", () => {
    expect(catalogueAmount(111.675, "SEK", "EUR")).toEqual({
      converted: true,
      text: "≈ €10.00",
      original: "SEK 111.68",
    });
  });
  it("retains an unsupported source currency rather than inventing a conversion", () => {
    expect(catalogueAmount(10, "NZD", "GBP")).toEqual({
      converted: false,
      text: "NZ$10.00",
      original: "NZD 10.00",
    });
  });
  it("keeps free offers free in every display currency", () => {
    for (const currency of displayCurrencies)
      expect(catalogueAmount(0, "USD", currency).text).not.toMatch(/[1-9]/);
  });
});
