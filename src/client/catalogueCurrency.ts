export const displayCurrencies = ["USD", "GBP", "EUR", "JPY", "CNY"] as const;
export type DisplayCurrency = (typeof displayCurrencies)[number];

// ECB's latest working-day snapshot when checked on Sunday 11 October 2026.
// Display estimates only; provider prices and payment currencies stay unchanged.
export const fxSnapshot = {
  date: "2026-10-09",
  label: "9 Oct 2026",
  source:
    "https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.fr.html",
  perEuro: { EUR: 1, USD: 1.1206, GBP: 0.84763, JPY: 177.34, CNY: 7.4992, SEK: 11.1675 } as Readonly<
    Record<string, number>
  >,
} as const;

export function catalogueAmount(amount: number, currency: string, display: DisplayCurrency) {
  const sourceRate = fxSnapshot.perEuro[currency];
  const targetRate = fxSnapshot.perEuro[display]!;
  const converted = currency !== display && sourceRate !== undefined;
  const value = converted ? (amount / sourceRate) * targetRate : amount;
  const format = (value: number, code: string) =>
    new Intl.NumberFormat("en-GB", { style: "currency", currency: code, currencyDisplay: "symbol" }).format(
      value,
    );
  return {
    converted,
    text: `${converted ? "≈ " : ""}${format(value, converted ? display : currency)}`,
    original: new Intl.NumberFormat("en-GB", { style: "currency", currency, currencyDisplay: "code" }).format(
      amount,
    ),
  };
}
