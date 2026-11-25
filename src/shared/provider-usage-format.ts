// How a provider account's figures read on a row: the provider's own balance,
// key cap or plan window, and the always-available "tokens via Conductor" line
// counted from the account's transcripts. A leaf module (no DOM) so the
// Accounts row, the picker, the overlay and the tests share one wording. An
// unknown figure reads "Usage unknown": never 0%, never "limit".

import type { AccountTokens, ProviderUsage, UsageBalance, UsageWindow } from "../types/ipc.generated";
import { formatTokens, resetUrgency } from "./formatters";

const SYMBOL: Record<string, string> = { USD: "$", CNY: "¥", EUR: "€", GBP: "£" };

/** "$12.40", "¥110.00", or "12.40 KRW" for a currency with no symbol here. */
export function formatMoney(amount: number, currency = "USD"): string {
  const n = Math.abs(amount).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  // Signed by the rounded figure, so -0.001 reads $0.00 and not -$0.00.
  const sign = amount < 0 && n !== "0.00" ? "-" : "";
  const sym = SYMBOL[currency.toUpperCase()];
  return sym ? `${sign}${sym}${n}` : `${sign}${n} ${currency.toUpperCase()}`;
}

/** Whole dollars bare ("$20"), anything else with cents: a cap and a balance on one line stay short. */
function dollars(amount: number): string {
  return formatMoney(amount).replace(/\.00$/, "");
}

export interface ProviderLine {
  /** The figures alone ("5h 42% · resets in 53m"), or null when none are known. */
  figures: string | null;
  /** What the row's own line says: `figures`, or "Usage unknown". */
  text: string;
  /** Why the figures are missing, for a tooltip. Never shown as a limit. */
  error: string | null;
  /** "1.8M tokens via Conductor this week", or null while nothing was counted. */
  tokens: string | null;
  /** A hover title with the 5h / today / 7 days split, when tokens were counted. */
  tokensTitle: string | null;
  /** True when the provider reports the key as empty, out of balance or at a cap. */
  atLimit: boolean;
  /** Short red flag for `atLimit` ("Out of balance", "Key limit"). */
  pill: string | null;
  /** The cap/window percent, 0..100, for a dial. Null with no capped window. */
  pct: number | null;
}

function windowText(w: UsageWindow): string | null {
  if (w.used_pct === null || w.used_pct === undefined) return null;
  const reset = resetUrgency(w.resets_at);
  return `${w.label} ${Math.round(w.used_pct)}%${reset ? ` · resets ${reset.text}` : ""}`;
}

function balanceText(b: UsageBalance): string {
  return `${formatMoney(b.amount, b.currency)} left`;
}

/** "$3.10 of $20 key limit left" for a key with a cap and a known remainder. */
function keyCapText(usage: ProviderUsage): string | null {
  const s = usage.spend;
  if (!s || s.limit === null || s.limit === undefined || s.limit_remaining === null || s.limit_remaining === undefined) return null;
  return `${dollars(s.limit_remaining)} of ${dollars(s.limit)} key limit left`;
}

export function tokensLine(tokens: AccountTokens | undefined): Pick<ProviderLine, "tokens" | "tokensTitle"> {
  const week = tokens?.seven_day ? sumOf(tokens.seven_day) : 0;
  if (!tokens || week <= 0) return { tokens: null, tokensTitle: null };
  return {
    tokens: `${formatTokens(week)} tokens via Conductor this week`,
    tokensTitle: `Counted from this account's chats in Conductor: ${formatTokens(sumOf(tokens.five_hour))} in the last 5h, ${formatTokens(sumOf(tokens.today))} today, ${formatTokens(week)} in 7 days. Usage outside Conductor is not included.`,
  };
}

function sumOf(s: AccountTokens["five_hour"]): number {
  return s.input + s.output + s.cache_read + s.cache_creation;
}

export function providerLine(usage: ProviderUsage | undefined, tokens?: AccountTokens): ProviderLine {
  const t = tokensLine(tokens);
  const blank: ProviderLine = { figures: null, text: "Usage unknown", error: usage?.error ?? null, atLimit: false, pill: null, pct: null, ...t };
  if (!usage || usage.error) return blank;

  const parts: string[] = [];
  const cap = keyCapText(usage);
  if (cap) parts.push(cap);
  else parts.push(...usage.windows.map(windowText).filter((p): p is string => p !== null));
  parts.push(...usage.balances.map(balanceText));
  const day = usage.spend?.day;
  if (day !== null && day !== undefined) parts.push(`${dollars(day)} today`);
  if (parts.length === 0 && usage.available === null) return blank;

  const capped = usage.windows.find((w) => (w.used_pct ?? 0) >= 100);
  const empty = usage.available === false || (usage.balances.length > 0 && usage.balances.every((b) => b.amount <= 0));
  const pill = empty ? "Out of balance" : capped ? capped.label.replace(/^(Daily|Weekly|Monthly) /, "") : null;
  const pcts = usage.windows.map((w) => w.used_pct).filter((p): p is number => p !== null && p !== undefined);
  const figures = parts.join(" · ") || (usage.available === false ? "Out of balance" : null);
  return {
    figures,
    text: figures ?? "Usage unknown",
    error: null,
    atLimit: pill !== null,
    pill,
    pct: pcts.length ? Math.max(...pcts) : null,
    ...t,
  };
}
