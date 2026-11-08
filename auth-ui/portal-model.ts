import type {HomeAssignment,FamilyMessage} from "./family-model.ts";
export interface Scout {
  id: string;
  scout_name: string | null;
  bsa_member_id?: string | null;
  den: string | null;
  grade?: string | null;
  birth_date?: string | null;
  parent_1_name?: string | null;
  parent_1_email?: string | null;
  parent_1_phone?: string | null;
  parent_2_name?: string | null;
  parent_2_email?: string | null;
  parent_2_phone?: string | null;
}
export interface Activity {
  id: string;
  title: string;
  kind: string;
  occurred_on: string;
  event_id?:string|null;
  scouting_year: string;
}
export interface Attendance {
  scout_id: string;
  activity_id: string;
  status: string;
  revision: number;
  occurred_on: string;
}
export interface Registration {
  scout_id: string;
  platform: string;
  status: string;
  revision: number;
  occurred_on: string;
}
export interface Requirement {
  code: string;
  description: string;
  source_url?: string;
}
export interface Adventure {
  id: string;
  name: string;
  rank: string;
  program_version: string;
  source_url: string;
  requirements: Requirement[];
  readiness_mode: string;
  catalog_context?: {
    adventure_type?: string;
    notes?: string;
    completion_options?: string;
  };
}
export interface Advancement {
  scout_id: string;
  adventure_id: string;
  revision: number;
  earned_on: string | null;
  badge_delivered_on: string | null;
  badge_form: string | null;
  completion_ready?: boolean | null;
}
export function compareAdventures(a: Adventure, b: Adventure): number {
  const priority = (adventure: Adventure) =>
    adventure.catalog_context?.adventure_type === "Required (Core)" ? 0 :
      adventure.catalog_context?.adventure_type === "Elective" ? 1 : 2;
  return priority(a) - priority(b) || a.name.localeCompare(b.name);
}
export interface Progress {
  scout_id: string;
  adventure_id: string;
  requirement_code: string;
  completed_on: string;
  completion_source: string;
}
export interface Equipment {
  id: string;
  scout_id: string;
  revision: number;
  action: string;
  scouting_year: string;
  occurred_on: string;
  item: string | null;
  quantity: number | null;
  size?: string | null;
  target_id?: string | null;
  amount_minor?: number | null;
  currency?: string | null;
  note?: string | null;
  voided?: boolean;
  outstanding_quantity?: number;
  returned_quantity?: number;
  lost_quantity?: number;
  paid_minor?: number;
  balance_minor?: number | null;
  price_minor?: number | null;
  price_currency?: string | null;
  delivered_quantity?: number;
  unfulfilled_quantity?: number;
}
export interface Eligibility {
  scout_id: string;
  revision: number;
  free_shirt_eligibility: string;
}
export interface Summary {
  scout_id: string;
  active_registration: string;
  scouting_registration: string;
  earned_adventures: number;
  badges_to_deliver: number;
  outstanding_loan_items: number;
  unpaid_loss_charges: number;
  unfulfilled_purchase_requests: number;
}
export interface PortalData {
  calendarEvents?: import("./community-model.ts").CommunityEvent[];
  registrationReports?:{scout_id:string;scouting_year:string;platform:string;reported_at:string}[];
  attribution?: import("./attribution.ts").Attribution[];
  familyPhotos?: {scout_id:string;kind:string;image:string}[];
  photos?: {scout_id:string;image:string}[];
  assignments:HomeAssignment[];
  familyMessages:FamilyMessage[];
  denPlans: { den: string; scouting_year: string; adventure_ids: string[]; revision: number }[];
  inventory: InventoryItem[];
  inventoryEvents: InventoryEvent[];
  scouts: Scout[];
  activities: Activity[];
  attendance: Attendance[];
  registrations: Registration[];
  adventures: Adventure[];
  advancement: Advancement[];
  progress: Progress[];
  events: Equipment[];
  loans: Equipment[];
  losses: Equipment[];
  purchases: Equipment[];
  eligibility: Eligibility[];
  summary: Summary[];
}
export const emptyData = (): PortalData => ({
  assignments:[],familyMessages:[],
  denPlans: [],
  inventory: [],
  inventoryEvents: [],
  scouts: [],
  activities: [],
  attendance: [],
  registrations: [],
  adventures: [],
  advancement: [],
  progress: [],
  events: [],
  loans: [],
  losses: [],
  purchases: [],
  eligibility: [],
  summary: [],
});
export interface InventoryItem {
  id: string; name: string; den: string | null; category: string;
  quantity_on_hand: number | null; revision: number;
  last_counted_on: string | null; last_recorded_on: string;
  source_context: Record<string, string>;
}
export interface InventoryEvent {
  id: string; item_id: string; action: string; quantity: number | null;
  quantity_before: number | null; quantity_after: number | null;
  revision: number; occurred_on: string; note: string;
}
export const escapeHtml = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
export function todayLA(now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  return ["year", "month", "day"]
    .map((key) => parts.find((p) => p.type === key)!.value)
    .join("-");
}
export const validYear = (value: string) =>
  /^\d{4}-\d{2}$/.test(value) &&
  String(Number(value.slice(0, 4)) + 1).slice(-2) === value.slice(-2);
export const denName = (value: string | null) =>
  value?.replace(/^\d+\s*[-–]\s*/, "") || "Den not recorded";
export const isWithdrawnScout = (scout: Scout) =>
  /^\s*\(withdraw\)/i.test(scout.den || "");
export const rankName = (rank: string) =>
  ({
    lion: "Lion",
    tiger: "Tiger",
    wolf: "Wolf",
    bear: "Bear",
    webelos: "Webelos",
    arrow_of_light: "Arrow of Light",
  })[rank] || rank;
export function denRank(den: string | null) {
  const name = denName(den).trim().toLowerCase();
  return ({ lion: "lion", lions: "lion", tiger: "tiger", tigers: "tiger",
    wolf: "wolf", wolves: "wolf", bear: "bear", bears: "bear", webelos: "webelos",
    aol: "arrow_of_light", "arrow of light": "arrow_of_light" } as Record<string, string>)[name] || "";
}
export function preferredDen(preference: string | null | undefined, scouts: Scout[]): string {
  const name = preference?.trim().toLowerCase();
  if (!name) return "";
  const dens = [...new Set(scouts.filter((s) => !isWithdrawnScout(s)).map((s) => s.den).filter((d): d is string => !!d))];
  const exact = dens.find((d) => d.trim().toLowerCase() === name);
  if (exact) return exact;
  const rank = denRank(name);
  const matches = rank ? dens.filter((d) => denRank(d) === rank) : [];
  return matches.length === 1 ? matches[0] : "";
}
export function dateLabel(value: string | null | undefined) {
  return value
    ? new Intl.DateTimeFormat("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: "UTC",
      }).format(new Date(value + "T12:00:00Z"))
    : "Not recorded";
}
export function safeSource(value: string) {
  try {
    const u = new URL(value);
    return u.protocol === "https:" && !u.username && !u.password ? u.href : "#";
  } catch {
    return "#";
  }
}
export const itemName = (item: string | null) =>
  ({
    tshirt: "T-shirt",
    neckerchief: "Neckerchief",
    slider: "Slider",
    lion_book: "Lion book",
    tiger_book: "Tiger book",
    first_aid_kit: "First-aid kit",
  })[item || ""] || "History review";
export const eventName = (action: string) =>
  ({
    give_free_item: "Free item issued",
    record_historical_shirt: "Past free shirt recorded",
    review_shirt_history: "Shirt history reviewed",
    issue_loan: "Loan issued",
    return_loan: "Loan returned",
    report_loan_loss: "Loss and charge recorded",
    pay_loan_loss: "Lost-item payment",
    request_purchase: "Purchase requested",
    set_purchase_price: "Purchase price recorded",
    pay_purchase: "Purchase payment",
    deliver_purchase: "Purchase handed out",
    void_equipment_event: "Entry corrected",
  })[action] || action;
export function toMinor(value: string, currency: string): number {
  if (!/^[A-Z]{3}$/.test(currency))
    throw new Error("Use a three-letter currency such as USD.");
  const digits =
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency,
    }).resolvedOptions().maximumFractionDigits ?? 2;
  if (
    !new RegExp(`^\\d+(?:\\.\\d{1,${Math.max(digits, 1)}})?$`).test(value) ||
    (!digits && value.includes("."))
  )
    throw new Error("Enter a valid amount for this currency.");
  const [whole, fraction = ""] = value.split(".");
  const n = Number(whole) * 10 ** digits + Number(fraction.padEnd(digits, "0"));
  if (!Number.isSafeInteger(n) || n > 100000000)
    throw new Error("The amount is too large.");
  return n;
}
export function moneyLabel(
  amount: number | null | undefined,
  currency: string | null | undefined,
) {
  if (amount == null || !currency) return "Price not recorded";
  try {
    const f = new Intl.NumberFormat("en-US", { style: "currency", currency });
    return f.format(
      amount / 10 ** (f.resolvedOptions().maximumFractionDigits ?? 2),
    );
  } catch {
    return "Amount unavailable";
  }
}
export interface Page<T> {
  rows: T[];
  total: number;
  next_offset: number | null;
}
export async function collectPages<T>(
  load: (offset: number) => Promise<Page<T>>,
): Promise<T[]> {
  const rows: T[] = [];
  let offset = 0;
  let total: number | undefined;
  const seen = new Set<number>();
  while (true) {
    if (seen.has(offset) || offset > 10000)
      throw new Error(
        "Too many records to load. Narrow the year or scout filter.",
      );
    seen.add(offset);
    const page = await load(offset);
    if (
      !Array.isArray(page.rows) ||
      !Number.isInteger(page.total) ||
      page.total < 0 ||
      (total !== undefined && total !== page.total)
    )
      throw new Error("Records changed while loading. Refresh and try again.");
    total = page.total;
    rows.push(...page.rows);
    if (page.next_offset === null) {
      if (rows.length !== total)
        throw new Error(
          "The complete list could not be loaded. Refresh and try again.",
        );
      return rows;
    }
    if (
      !Number.isInteger(page.next_offset) ||
      page.next_offset <= offset ||
      !page.rows.length
    )
      throw new Error("The complete list could not be loaded.");
    offset = page.next_offset;
  }
}
