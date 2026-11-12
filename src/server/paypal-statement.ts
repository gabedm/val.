import type { BillingCycle } from "../shared/subscriptions";

export interface StatementRecord {
  id: string;
  date: string;
  name: string;
  email: string;
  currency: string;
  grossMinor: number;
  description: string;
  parent: string;
  status: string;
}
export interface StatementScope {
  start: string;
  end: string;
}

/** Runs inside the browser VM. Raw rows, emails and bank columns never leave it. */
export function parsePayPalStatement(text: string, scope: StatementScope): StatementRecord[] {
  if (typeof text !== "string" || text.length > 10 * 1024 * 1024)
    throw new Error("Unsupported statement size.");
  text = text.replace(/^\uFEFF/, "");
  function parse(delimiter: string) {
    const rows: string[][] = [];
    let row: string[] = [],
      field = "",
      quoted = false;
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      if (char === '"') {
        if (quoted && text[i + 1] === '"') {
          field += '"';
          i++;
        } else if (quoted) quoted = false;
        else if (!field) quoted = true;
        else throw new Error("Malformed statement quoting.");
      } else if (char === delimiter && !quoted) {
        row.push(field);
        field = "";
      } else if ((char === "\n" || char === "\r") && !quoted) {
        if (char === "\r" && text[i + 1] === "\n") i++;
        row.push(field);
        if (row.some((cell) => cell.trim())) rows.push(row);
        row = [];
        field = "";
      } else field += char;
    }
    if (quoted) throw new Error("Unclosed statement quote.");
    if (field || row.length) {
      row.push(field);
      if (row.some((cell) => cell.trim())) rows.push(row);
    }
    return rows;
  }
  let headers: string[] | undefined,
    table: string[][] = [];
  for (const delimiter of [",", ";", "\t"]) {
    let rows: string[][];
    try {
      rows = parse(delimiter);
    } catch {
      continue;
    }
    const index = rows.findIndex((row) =>
      ["Date", "Name", "Transaction ID", "Currency", "Gross"].every((name) =>
        row.some((cell) => cell.trim() === name),
      ),
    );
    if (index >= 0) {
      headers = rows[index]!.map((cell) => cell.trim());
      table = rows.slice(index + 1);
      break;
    }
  }
  if (!headers || new Set(headers).size !== headers.length) throw new Error("Unsupported statement columns.");
  if (table.length > 50_000 || table.some((row) => row.length !== headers.length))
    throw new Error("Statement rows are incomplete.");
  const columns = Object.fromEntries(headers.map((name, index) => [name, index]));
  const cell = (row: string[], name: string) =>
    columns[name] === undefined ? "" : (row[columns[name]!] ?? "").trim();
  const numeric = table.map((row) => cell(row, "Date").match(/^(\d{1,2})\/(\d{1,2})\/(20\d{2})$/));
  const iso = (value: RegExpMatchArray | null, dayFirst: boolean) => {
    if (!value) return null;
    const year = Number(value[3]),
      month = Number(value[dayFirst ? 2 : 1]),
      day = Number(value[dayFirst ? 1 : 2]);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
      ? date.toISOString().slice(0, 10)
      : null;
  };
  const possible = [false, true].filter((order) =>
    numeric.every((value) => {
      const date = iso(value, order);
      return date !== null && date >= scope.start && date <= scope.end;
    }),
  );
  if (
    table.length &&
    possible.length !== 1 &&
    !numeric.every((value) => iso(value, false) === iso(value, true))
  )
    throw new Error("Statement date order is ambiguous or outside its requested range.");
  const dayFirst = possible[0] ?? false;
  function money(value: string, currency: string) {
    const precision = /^(JPY|KRW|VND|CLP|XAF|XOF|XPF)$/.test(currency)
      ? 0
      : /^(BHD|JOD|KWD|OMR|TND)$/.test(currency)
        ? 3
        : 2;
    let clean = value.replace(/[\s\u00A0]/g, "").replace(/−/g, "-");
    if (/^\(.*\)$/.test(clean)) clean = "-" + clean.slice(1, -1);
    if (!/^[+-]?[\d.,]+$/.test(clean)) throw new Error("Unsupported statement amount.");
    const comma = clean.lastIndexOf(","),
      dot = clean.lastIndexOf(".");
    if (comma >= 0 && dot >= 0) {
      const whole = clean.slice(0, Math.max(comma, dot));
      const grouped = comma > dot ? /^[+-]?\d{1,3}(?:\.\d{3})+$/ : /^[+-]?\d{1,3}(?:,\d{3})+$/;
      if (!grouped.test(whole)) throw new Error("Malformed statement amount grouping.");
      clean = comma > dot ? clean.replace(/\./g, "").replace(",", ".") : clean.replace(/,/g, "");
    } else if (comma >= 0) {
      if (/^[+-]?\d+,\d+$/.test(clean) && clean.length - comma - 1 <= precision)
        clean = clean.replace(",", ".");
      else {
        if (!/^[+-]?\d{1,3}(?:,\d{3})+$/.test(clean)) throw new Error("Malformed statement amount grouping.");
        clean = clean.replace(/,/g, "");
      }
    }
    const match = clean.match(/^([+-]?)(\d+)(?:\.(\d+))?$/);
    if (!match || (match[3]?.length ?? 0) > precision) throw new Error("Unsupported amount precision.");
    const amount = Number(match[2]) * 10 ** precision + Number((match[3] ?? "").padEnd(precision, "0"));
    if (!Number.isSafeInteger(amount) || amount > 99_999_999_999)
      throw new Error("Statement amount is too large.");
    return match[1] === "-" ? -amount : amount;
  }
  const seen = new Map<string, StatementRecord>();
  table.forEach((row, index) => {
    const id = cell(row, "Transaction ID"),
      currency = cell(row, "Currency"),
      date = iso(numeric[index] ?? null, dayFirst);
    if (!/^[A-Z0-9]{17}$/.test(id) || !/^[A-Z]{3}$/.test(currency) || !date)
      throw new Error("Statement payment identity is incomplete.");
    const record: StatementRecord = {
      id,
      currency,
      date,
      name: cell(row, "Name"),
      email: cell(row, "From Email Address").toLowerCase(),
      grossMinor: money(cell(row, "Gross"), currency),
      description: cell(row, "Description") || cell(row, "Type"),
      parent: cell(row, "Reference Txn ID"),
      status: cell(row, "Status"),
    };
    const key = JSON.stringify([id, currency, record.description]);
    if (seen.has(key) && JSON.stringify(seen.get(key)) !== JSON.stringify(record))
      throw new Error("Conflicting duplicate payment reference.");
    seen.set(key, record);
  });
  return [...seen.values()];
}

export interface StatementGroup {
  key: string;
  merchant: string;
  currency: string;
  parent: string | null;
  amountMinor: number;
  cycle: BillingCycle | null;
  paymentCount: number;
  lastPaidOn: string;
}

/** Pattern evidence is explicit; a permission or one purchase never establishes cadence. */
export function groupStatementPayments(
  records: StatementRecord[],
  asOf: string,
): { groups: StatementGroup[]; unresolvedPayments: number } {
  const groups = new Map<string, StatementRecord[]>();
  let unresolvedPayments = 0;
  for (const record of records) {
    if (
      record.grossMinor >= 0 ||
      /refund|reversal|chargeback|(?:bank|balance|credit) (?:payment|transfer)|funding|withdrawal|deposit|^.*fee$/i.test(
        record.description,
      ) ||
      (record.status && !/^(completed|processed|paid)$/i.test(record.status))
    )
      continue;
    if (
      !record.name.trim() ||
      record.name.length > 180 ||
      /@|https?:|[\r\n]|\b(?:ignore|instructions|reveal|execute|system prompt|api.?key|access.?token)\b/i.test(
        record.name,
      )
    ) {
      unresolvedPayments++;
      continue;
    }
    const parent = /^[IB]-[A-Z0-9]{10,24}$/.test(record.parent) ? record.parent : null;
    const key = JSON.stringify(
      parent
        ? ["agreement", parent, record.currency]
        : [
            "merchant",
            record.name.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim(),
            record.email,
            record.currency,
          ],
    );
    const group = groups.get(key);
    if (group) group.push(record);
    else groups.set(key, [record]);
  }
  const result: StatementGroup[] = [];
  for (const [key, values] of groups) {
    const unique = [...new Map(values.map((value) => [value.id, value])).values()].sort((a, b) =>
      a.date.localeCompare(b.date),
    );
    const last = unique.at(-1)!;
    const dates = [...new Set(unique.map((value) => value.date))].sort();
    const recent = dates.slice(-3);
    const gaps = recent
      .slice(1)
      .map((date, index) => (Date.parse(date) - Date.parse(recent[index]!)) / 86400_000);
    const age = (Date.parse(asOf) - Date.parse(last.date)) / 86400_000;
    const daysOfMonth = recent.map((date) => Number(date.slice(8)));
    const consecutiveMonths = recent.slice(1).every((date, index) => {
      const before = new Date(recent[index]!),
        after = new Date(date);
      return (
        (after.getUTCFullYear() - before.getUTCFullYear()) * 12 +
          after.getUTCMonth() -
          before.getUTCMonth() ===
        1
      );
    });
    const lastFour = dates.slice(-4);
    const thirtyDayGaps = lastFour
      .slice(1)
      .map((date, index) => (Date.parse(date) - Date.parse(lastFour[index]!)) / 86400_000);
    const thirtyDays =
      recent.length >= 3 &&
      gaps.every((days) => days === 30) &&
      (!consecutiveMonths || (lastFour.length === 4 && thirtyDayGaps.every((days) => days === 30))) &&
      age >= 0 &&
      age <= 45;
    const monthly =
      recent.length >= 3 &&
      !gaps.every((days) => days === 28) &&
      !gaps.every((days) => days === 30) &&
      Math.max(...daysOfMonth) - Math.min(...daysOfMonth) <= 3 &&
      gaps.every((days) => days >= 27 && days <= 32) &&
      consecutiveMonths &&
      age >= 0 &&
      age <= 45;
    const annual =
      dates.length >= 2 &&
      (Date.parse(dates.at(-1)!) - Date.parse(dates.at(-2)!)) / 86400_000 >= 350 &&
      (Date.parse(dates.at(-1)!) - Date.parse(dates.at(-2)!)) / 86400_000 <= 380 &&
      age >= 0 &&
      age <= 400;
    const cycle = thirtyDays ? "30_days" : monthly ? "month" : annual ? "year" : null;
    if (!cycle) unresolvedPayments += unique.length;
    result.push({
      key,
      merchant: last.name.trim(),
      currency: last.currency,
      parent: /^[IB]-[A-Z0-9]{10,24}$/.test(last.parent) ? last.parent : null,
      amountMinor: -last.grossMinor,
      cycle,
      paymentCount: unique.length,
      lastPaidOn: last.date,
    });
  }
  return { groups: result, unresolvedPayments };
}
