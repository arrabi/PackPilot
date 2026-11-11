import {backLabel} from './back-navigation.ts';
import {createAssistantPanel} from './assistant-ui.ts';
import type {AssistantTransport} from '../supabase/functions/_shared/assistant-types.ts';
import {familyWorkCards,familyWorkStatus} from './family-work-ui.ts';
import {familyWorkOverview} from './family-work-overview.ts';
import {returnHomeAfterScenario,takeScenarioNotice} from './scenario-navigation.ts';
import {phoneLink} from './phone.ts';
import {isV2,decorateV2,decoratePrevious,installV2Review} from './v2-shell.ts';
import {v2Home,v2ScoutList,v2Badges,v2More,v2Gear,v2Portrait} from './v2-views.ts';
import {badgeArt} from './badge-art.ts';
import {progressWizard, progressEligible, requirementStep} from './progress-wizard.ts';
import{accountBar,appFooter,appLink,captureView,clearContext,helpPanel,readContext,renderNavigation,restoreView,saveContext}from'./app-shell.ts';
import {valueAttribution,scoutValueHistory} from './attribution.ts';
import {
  emptyData,
  escapeHtml as h,
  todayLA,
  validYear,
  denName,
  isWithdrawnScout,
  denRank,
  preferredDen,
  compareAdventures,
  rankName,
  dateLabel,
  safeSource,
  itemName,
  eventName,
  moneyLabel,
  toMinor,
  type PortalData,
  type Scout,
  type Equipment,
  type Adventure,
} from "./portal-model.ts";
import { needsAdventureAction, denRecommendations } from "./portal-planning.ts";
import {leaderFamilyPanel} from "./leader-family.ts";
import { betaHome, betaMore, decorateBeta } from "./portal-beta.ts";
import { renderHome } from "./portal-home.ts";
import { inventoryCategories } from "../supabase/functions/_shared/inventory.ts";
const inventoryCategoryLabels: Record<string, string> = { required_badge: "Required badges", elective_badge: "Elective badges", neckerchief: "Neckerchiefs", slider: "Sliders", book: "Books", rank_insignia: "Rank insignia", other: "Other items" };
const inventoryActionLabels: Record<string, string> = { define_inventory_item: "Opening stock", inventory_count: "Count / correction", inventory_receive: "Stock received", inventory_issue: "Stock issued" };
const packLogoUrl = new URL("../resources/packpilot-logo.svg", import.meta.url).href;
const packLogo = `<img class="pack-logo" src="${packLogoUrl}" alt="PackPilot" width="580" height="545">`;
const mcpServerUrl = (import.meta.env?.VITE_SUPABASE_URL || '') + '/functions/v1/scouts-mcp';

export interface Entry {
  request_id: string;
  command: Record<string, unknown>;
}
export interface SaveReceipt { notificationsQueued: number }
export interface PortalService {
  assistant?: AssistantTransport;
  identity(): Promise<{ email: string } | null>;
  capabilities(): Promise<{ approved: boolean; can_record: boolean; is_admin?: boolean; default_den?: string | null }>;
  load(year: string): Promise<PortalData>;
  save(entries: Entry[]): Promise<void | SaveReceipt>;
  saveFamily?(entries:Entry[]):Promise<void | SaveReceipt>;
  loadPhotos?(child:string):Promise<{scout_id:string;kind:string;image:string}[]>;
  loadFamily?(year:string):Promise<Pick<PortalData,"assignments"|"familyMessages">>;
  signIn(): Promise<void>;
  signOut(): Promise<void>;
  onSignOut?(callback: () => void): () => void;
}
const paths: Record<string, string> = {
  home: "M3 11 12 3l9 8M5 10v11h5v-7h4v7h5V10",
  users:
    "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M16 3a4 4 0 0 1 0 8M22 21v-2a4 4 0 0 0-3-3.87M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0",
  check: "m5 12 4 4L19 6",
  calendar:
    "M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2",
  compass: "M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0m-6-4-3 5-5 3 3-5 5-3",
  badge:
    "m12 3 3 3 4 .5.5 4L22 14l-3 3-.5 4-4 .5L12 24l-3-2.5-4-.5-.5-4L2 14l2.5-3.5.5-4L9 6l3-3M9 13l2 2 4-4",
  bag: "M8 7V5a4 4 0 0 1 8 0v2M6 7h12l2 14H4L6 7M9 12h6",
  arrow: "M5 12h14m-6-6 6 6-6 6",
  search: "m21 21-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0",
  refresh:
    "M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 12-1l2 2M4 16l2 2a7 7 0 0 0 12-1",
  flag: "M4 22V3m0 0c5-4 11 4 16 0v11c-5 4-11-4-16 0",
  book: "M12 6c-3-3-7-3-10-2v15c4-1 7-1 10 2m0-15c3-3 7-3 10-2v15c-4-1-7-1-10 2V6",
  logout: "M9 5H4v14h5M12 12h10m-4-4 4 4-4 4",
};
const icon = (name: string) =>
  `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[name] || paths.flag}"/></svg>`;
const labels: Record<string, string> = {
  home: "Home",
  overview: "Overview",
  next: "What’s next",
  attendance: "Attendance",
  scouts: "Scouts",
  adventures: "Adventures & badges",
  equipment: "Equipment",
  inventory: "Inventory",
  followups: "Follow-ups",
  families: "Families & messages",
};
const statusLabel = (status: string) =>
  ({
    confirmed: "Confirmed",
    not_registered: "Not registered",
    unknown: "Needs verification",
    not_recorded: "Not recorded",
    present: "Present",
    absent: "Absent",
    excused: "Excused",
    eligible: "Eligible",
    ineligible: "Not eligible",
    pending: "Awaiting badge",
  })[status] || status;
const tag = (status: string, label = statusLabel(status)) =>
  `<span class="tag ${["confirmed", "present", "eligible"].includes(status) ? "good" : ["not_registered", "absent", "pending"].includes(status) ? "warm" : "neutral"}">${h(label)}</span>`;
const option = (value: string, label: string, selected: string) =>
  `<option value="${h(value)}" ${value === selected ? "selected" : ""}>${h(label)}</option>`;
const initials = (name: string | null) =>
  (name || "?")
    .split(/\s+/)
    .map((x) => x[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
const text = (form: FormData, key: string) =>
  String(form.get(key) || "").trim();
const count = (form: FormData, key: string) => Number(text(form, key));

export function mountPortal(root: HTMLElement, service: PortalService, options: { beta?: boolean } = {}) {
  let assistantPanel:ReturnType<typeof createAssistantPanel>|null=null;
  const beta = options.beta !== false;
  const v2 = isV2(root.ownerDocument.defaultView!);
  const removeReview = v2 ? installV2Review(root) : ()=>{};
  const doc = root.ownerDocument,
    win = doc.defaultView!;
  let email = "",
    approved = false,
    canRecord = false,
    isAdmin = false,
    loading = true,
    busy = false,
    year = readContext(win,"leader").year,
    den = readContext(win,"leader").den,
    search = "",
    notice = v2?takeScenarioNotice(win,'leader'):'',
    noticeKind = "success",
    error = "",
    epoch = 0,
    disposed = false;
  let data = emptyData(),
    activityId = new URL(win.location.href).searchParams.get("activity")||"",
    adventureId = "",
    adventureAction = v2&&new URL(win.location.href).searchParams.get('record')==='deliver_badge'?"deliver_badge":"record_requirement",
    requirementCode = "",
    badgeForm = "",
    attendanceBulkStatus = "present",
    priorityDraft: Set<string> | null = null,
    priorityRevision = 0,
    profileTab = "overview",
    familyScoutId = "",
    assignmentInstructions = "", assignmentDue = "",
    equipmentAction = "give_free_item",
    equipmentTarget = "",
    inventoryItemId = "",
    inventoryCategory = "",
    inventorySearch = "",
    inventoryAction = "inventory_count",
    addingInventory = false,
    selectedDate = todayLA();
  let progressClassic = !v2 && win.localStorage.getItem('pack99-progress-view') === 'classic';
  let wizardStep = adventureAction==='deliver_badge'?1:0, correctionReason = '';
  let wizardScoutScope = '', badgeSearch = '', familySearch = '';
  let lastRenderedView = "";
  let homeCompletionNotice = !!notice;
  let refreshedAt = "";
  const familyMessageDrafts = new Map<string,string>();
  const familyReviewDrafts = new Map<string,{note:string;decision:string}>();
  const familyDrafts={messages:familyMessageDrafts,reviews:familyReviewDrafts};
  const hasDraft = () => familyMessageDrafts.size > 0 || familyReviewDrafts.size > 0 || !!assignmentInstructions.trim() || !!assignmentDue || (!beta && attendanceSelected.size > 0) || adventureSelected.size > 0 || attendanceDraft.size > 0 || priorityDraft !== null;
  const abandonDraft = () => {
    if (!beta || !hasDraft() || pending) return true;
    if (!win.confirm("Discard your unsaved changes?")) return false;
    attendanceSelected.clear(); adventureSelected.clear(); adventureRevisions.clear(); attendanceDraft.clear(); priorityDraft = null;
    familyMessageDrafts.clear();familyReviewDrafts.clear();assignmentInstructions="";assignmentDue="";
    if (beta) syncAttendanceSelection();
    return true;
  };
  const attendanceSelected = new Set<string>();
  const attendanceRevisions = new Map<string, number>();
  const adventureSelected = new Set<string>();
  const adventureRevisions = new Map<string, number>();
  const attendanceDraft = new Map<
    string,
    { status: string; revision: number }
  >();
  let pending: { entries: Entry[]; offset: number; label: string; family?:boolean; notificationsQueued:number; receiptKnown:boolean } | null =
    null;
  const writeDisabled = () => !canRecord || busy || pending !== null;
  const activeScouts = () => data.scouts.filter((s) => !isWithdrawnScout(s));
  const filtered = () =>
    activeScouts().filter(
      (s) =>
        (!den || s.den === den) &&
        (!search ||
          `${s.scout_name} ${denName(s.den)}`
            .toLowerCase()
            .includes(search.toLowerCase())),
    );
  const scoutById = (id: string) => activeScouts().find((s) => s.id === id);
  const adventureRoster = () => v2&&wizardScoutScope?filtered().filter(s=>s.id===wizardScoutScope):filtered();
  function syncAttendanceSelection() {
    if (!beta) return;
    attendanceSelected.clear(); attendanceDraft.clear(); attendanceRevisions.clear(); attendanceBulkStatus = "present";
    for (const s of activeScouts()) {
      const current = data.attendance.find((r) => r.activity_id === activityId && r.scout_id === s.id);
      attendanceRevisions.set(s.id, current?.revision ?? 0);
      if (current?.status === "present") attendanceSelected.add(s.id);
    }
  }
  function selectAttendance(scoutId: string, checked: boolean) {
    if (checked) attendanceSelected.add(scoutId); else attendanceSelected.delete(scoutId);
    const current = data.attendance.find((r) => r.activity_id === activityId && r.scout_id === scoutId);
    // Unchecking a saved attendee is an explicit absence correction. Untouched
    // unrecorded/absent/excused scouts keep their existing state.
    const status = checked ? attendanceBulkStatus : current?.status === "present" ? "absent" : current?.status || "";
    const key = `${activityId}:${scoutId}`;
    if (!status || status === current?.status) attendanceDraft.delete(key);
    else attendanceDraft.set(key, {status, revision: attendanceRevisions.get(scoutId) ?? current?.revision ?? 0});
  }
  const attendanceChanges = () => activeScouts().filter((s) => !den || s.den === den).flatMap((s) => {
    const draft = attendanceDraft.get(`${activityId}:${s.id}`);
    return draft ? [{scout: s, ...draft}] : [];
  });
  function rememberAdventureSelection() {
    adventureSelected.clear();
    for (const input of root.querySelectorAll<HTMLInputElement>('input[name="scout_ids"]:checked')) adventureSelected.add(input.value);
  }
  function touchScout(s: Scout, kind: "attendance" | "adventure", detail: string) {
    const selected = kind === "attendance" ? attendanceSelected : adventureSelected;
    return `<label class="scout-choice ${selected.has(s.id) ? "is-selected" : ""}"><input type="checkbox" id="${kind}-scout-${h(s.id)}" name="${kind === "adventure" ? "scout_ids" : "attendance_scout_ids"}" value="${h(s.id)}" ${selected.has(s.id) ? "checked" : ""} ${writeDisabled() ? "disabled" : ""}><span>${v2?v2Portrait(data,s):''}<strong>${h(s.scout_name || "Name not recorded")}</strong><small>${h(detail)}</small></span><span class="choice-check" aria-hidden="true">${selected.has(s.id) ? "✓" : "+"}</span></label>`;
  }
  const scoutLink = (s: Scout) =>
    `<a class="scout-link" href="#scout/${h(s.id)}"><span class="avatar">${data.photos?.find(p=>p.scout_id===s.id)?`<img src="${h(data.photos.find(p=>p.scout_id===s.id)!.image)}" alt="" class="avatar-photo">`:h(initials(s.scout_name))}</span><span>${h(s.scout_name || "Name not recorded")}<small>${h(denName(s.den))}</small></span></a>`;
  const stat = (value: number, label: string, detail: string, kind = "") =>
    `<div class="stat ${kind}"><span class="stat-label">${h(label)}</span><strong>${value}</strong><small>${h(detail)}</small></div>`;
  const empty = (title: string, description: string, action = "") =>
    `<div class="empty-state">${icon("compass")}<h3>${h(title)}</h3><p>${h(description)}</p>${action}</div>`;
  const heading = (
    eyebrow: string,
    title: string,
    description: string,
    action = "",
  ) =>
    `<div class="page-heading"><div><p class="eyebrow">${h(eyebrow)}</p><h1>${h(title)}</h1><p class="lede">${h(description)}</p></div>${action}</div>`;
  const dateInput = (name = "occurred_on", value = selectedDate, label = "Date") =>
    `<label>${h(label)}<input type="date" name="${name}" value="${h(value)}" max="${todayLA()}" required></label>`;
  const saveButton = (label = "Save changes") =>
    `<button class="button primary" type="submit" ${writeDisabled() ? "disabled" : ""}>${icon("check")}${h(busy ? "Saving…" : label)}</button>`;
  const writerNote = () =>
    !canRecord
      ? `<p class="form-note">You have read-only access. Ask the pack administrator for recording access.</p>`
      : "";
  const registration = (s: Scout, platform: string) =>
    data.registrations.find(
      (r) => r.scout_id === s.id && r.platform === platform,
    );
  const advancement = (s: Scout, a: Adventure) =>
    data.advancement.find(
      (v) => v.scout_id === s.id && v.adventure_id === a.id,
    );
  const eligibility = (s: Scout) =>
    data.eligibility.find((e) => e.scout_id === s.id);
  let lastProfileRoute="";
  function route() {
    const hash = win.location.hash.slice(1);
    if(v2 && hash.startsWith('families/'))return{view:'families',id:decodeURIComponent(hash.slice(9))};
    if(v2 && hash.startsWith('badge/'))return{view:'badges',id:decodeURIComponent(hash.slice(6))};
    if(v2 && ['badges','gear'].includes(hash))return{view:hash,id:''};
    if(hash.startsWith('scout/')){const parts=hash.split('/');const id=decodeURIComponent(parts[1]||'');if(['overview','adventures','equipment','registration','family','photos','history'].includes(parts[2]))profileTab=parts[2];else if(lastProfileRoute!==id)profileTab='overview';lastProfileRoute=id;return{view:'profile',id,item:parts[3]?decodeURIComponent(parts[3]):''};}
    return { view: beta && hash === "more" ? "more" : labels[hash] ? hash : "home", id: "" };
  }
  function setNotice(value: string, kind = "success") {
    notice = value;
    noticeKind = kind;
    render();
  }
  function loginScreen() {
    return `<main class="login-layout"><section class="login-story"><a class="brand" href="/" aria-label="PackPilot home">${packLogo}<span>PACKPILOT<small>THE LEADER FIELDBOOK</small></span></a><p class="eyebrow">A LITTLE LESS ADMIN. A LITTLE MORE ADVENTURE.</p><h1>More time<br>for the good stuff.</h1><p>Attendance, adventures, and everything your den needs. Together in one fieldbook.</p><div class="login-trail"><span>${icon("calendar")}Show up.</span><span>${icon("compass")}Try something new.</span><span>${icon("badge")}Celebrate it.</span></div><div class="forest" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><span></span></div><small class="story-foot">DO YOUR BEST · PACKPILOT</small></section><section class="login-panel"><div class="login-card"><span class="kicker">WELCOME, LEADER</span><h2>Your den.<br>Your next adventure.</h2><p>Sign in with your approved Google account to open the leader fieldbook.</p>${error ? `<div class="notice error" role="alert">${h(error)}</div>` : ""}<button class="button google" data-action="login" ${loading ? "disabled" : ""}><span class="google-g" aria-hidden="true">G</span>${loading ? "Checking your access…" : "Continue with Google"}${icon("arrow")}</button>${email ? `<p class="signed-as">Signed in as ${h(email)}</p><button class="text-button" data-action="logout">Use another account</button>` : ""}<a class="button secondary parents-portal-entry" href="/parents">Parents Portal →</a><div class="login-assurance">${icon("bag")}<p>For approved PackPilot leaders.<br>Access is managed by the pack administrator.</p></div></div><footer>Already connecting an AI assistant? <a href="/oauth/consent">Open authorization</a></footer></section></main>`;
  }
  function navigation(view: string) {
    const links = Object.entries(labels);
    links.splice(1, 0, ["events", "Events"]);
    return links
      .map(
        ([key, label]) =>
          `<a href="${key === "events" ? "/events" : "#" + key}" class="nav-link ${view === key || (view === "profile" && key === "scouts") ? "active" : ""}" ${view === key ? 'aria-current="page"' : ""}>${icon({ home: "home", overview: "flag", next: "compass", attendance: "calendar", events: "calendar", scouts: "users", adventures: "compass", equipment: "bag", inventory: "bag", followups: "flag" }[key]!)}<span>${label}</span>${key === "followups" && data.summary.some((s) => s.badges_to_deliver || s.scouting_registration !== "confirmed") ? '<span class="nav-dot"></span>' : ""}</a>`,
      )
      .join("");
  }
  function overview() {
    const scouts = filtered(),
      ids = new Set(scouts.map((s) => s.id)),
      summaries = data.summary.filter((s) => ids.has(s.scout_id));
    const badges = summaries.reduce((n, s) => n + s.badges_to_deliver, 0),
      registrationGaps = summaries.filter(
        (s) =>
          s.active_registration !== "confirmed" ||
          s.scouting_registration !== "confirmed",
      ).length;
    const upcoming = data.activities
      .filter((a) => a.occurred_on <= todayLA())
      .sort((a, b) => b.occurred_on.localeCompare(a.occurred_on))
      .slice(0, 3);
    return (
      heading(
        "YOUR PACK, AT A GLANCE",
        "Good things ahead.",
        `A clear view of ${den ? denName(den) : "the pack"} for ${year}.`,
        `<a class="button primary" href="#attendance">${icon("calendar")}Take attendance</a><a class="button secondary" href="#next">What’s next for the den?</a>`,
      ) +
      `<div class="stats">${stat(scouts.length, "Scouts", "In the selected den or pack")}${stat(
        summaries.reduce((n, s) => n + s.earned_adventures, 0),
        "Adventures earned",
        "Recorded this program year",
      )}${stat(badges, "Badges to hand out", "A little recognition goes a long way", "accent")}${stat(registrationGaps, "Registration follow-ups", "Includes unverified registrations")}</div><div class="two-column"><section class="panel"><div class="panel-heading"><div><p class="eyebrow">MAKE THE NEXT SESSION EASY</p><h2>The leader’s checklist</h2></div>${icon("flag")}</div><a class="task-link" href="#attendance"><span class="task-icon">${icon("calendar")}</span><span><strong>Start with who’s here</strong><small>Record a session, hike, or event.</small></span>${icon("arrow")}</a><a class="task-link" href="#adventures"><span class="task-icon">${icon("compass")}</span><span><strong>Keep their adventure moving</strong><small>Complete requirements and celebrate earned badges.</small></span>${icon("arrow")}</a><a class="task-link" href="#equipment"><span class="task-icon">${icon("bag")}</span><span><strong>Make sure they’re equipped</strong><small>Shirts, books, loans, and items to hand out.</small></span>${icon("arrow")}</a></section><section class="panel"><div class="panel-heading"><div><p class="eyebrow">IN THE FIELDBOOK</p><h2>Recent activities</h2></div><a class="text-link" href="#attendance">View all ${icon("arrow")}</a></div>${upcoming.length ? upcoming.map((a) => `<button class="activity-card" data-action="open-activity" data-id="${h(a.id)}"><span class="date-tile"><b>${h(new Date(a.occurred_on + "T12:00Z").getUTCDate())}</b><small>${h(new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" }).format(new Date(a.occurred_on + "T12:00Z")))}</small></span><span><strong>${h(a.title)}</strong><small>${h(a.kind)} · ${h(dateLabel(a.occurred_on))}</small></span>${icon("arrow")}</button>`).join("") : empty("The next adventure starts here", "Create a session or event to begin taking attendance.", '<a class="text-link" href="#attendance">Open attendance →</a>')}</section></div><div class="field-note">${icon("book")}<p><strong>A note about the records</strong> Missing registration or equipment history means “not recorded,” not “never happened.” Review past shirt history before issuing a free shirt.</p></div>
      <section class="panel claude-connection" aria-labelledby="claude-connection-title">
        <div class="panel-heading"><div><p class="eyebrow">YOUR FIELDBOOK, IN CLAUDE</p><h2 id="claude-connection-title">Connect Claude to PackPilot</h2></div>${icon("compass")}</div>
        <p class="muted">Ask Claude about your scouts, adventures, attendance, and equipment using the same PackPilot records and permissions.</p>
        <ol class="connection-steps">
          <li>Open <a href="https://claude.ai/" target="_blank" rel="noopener noreferrer">Claude</a> and go to <strong>Customize → Connectors</strong> (or <strong>Settings → Connectors</strong> in older layouts).</li>
          <li>Choose <strong>Add custom connector</strong>, name it <strong>PackPilot</strong>, and paste the MCP server URL below.</li>
          <li>Connect and authorize PackPilot. Sign in with your <strong>approved Google account</strong> and review the access request.</li>
          <li>Start a new Claude chat and enable the PackPilot connector. Try asking: <strong>“Which scouts have earned badges that still need to be handed out?”</strong></li>
        </ol>
        <div class="connection-url-label"><label for="mcp-server-url">MCP server URL</label><div class="connection-url-row"><input id="mcp-server-url" class="connection-url" type="text" readonly spellcheck="false" value="${mcpServerUrl}"><div class="connection-url-actions"><button class="button secondary connection-copy" type="button" data-action="copy-mcp-url" aria-label="Copy MCP server URL">Copy URL</button><a class="button secondary" href="https://claude.ai/customize/connectors" target="_blank" rel="noopener noreferrer" aria-label="Open Claude connectors in a new tab">Open Claude connectors</a></div></div><p id="mcp-copy-status" class="form-note connection-copy-status" role="status" aria-live="polite"></p></div>
        <div class="connection-examples">
          <h3>Simple things to ask Claude</h3>
          <div class="connection-example-grid">
            <div><h4>Ask about the pack</h4><ul>
              <li>“How many scouts are in each den?”</li>
              <li>“Who is confirmed in Active.com but still needs Scouting.org registration verified?”</li>
              <li>“Which scouts have earned badges that have not been handed out yet?”</li>
            </ul></div>
            <div><h4>Record what happened</h4><ul>
              <li>“Mark [scout name] present at [meeting name] on [date].”</li>
              <li>“Record that [scout name] completed requirement [number] of [adventure name] on [date].”</li>
              <li>“Record that [scout name] returned their loaned slider on [date].”</li>
            </ul></div>
          </div>
          <p class="form-note">Replace the bracketed placeholders with the actual names and dates. Check the scout and details before asking Claude to save a change.</p>
        </div>
        <p class="form-note">Claude uses your existing PackPilot access. Recording changes requires recording permission. If only the original read-only roster tools appear, refresh the connector’s tools or reconnect it, then start a new chat. Custom connector availability depends on your Claude plan and workspace settings.</p>
      </section>`
    );
  }
  function attendanceView() {
    const active = data.activities.find((a) => a.id === activityId),
      scouts = filtered();
    const existing = data.attendance.filter(
      (r) => r.activity_id === activityId,
    );
    const present = scouts.filter((s) => (attendanceDraft.get(`${activityId}:${s.id}`)?.status ?? existing.find((r) => r.scout_id === s.id)?.status) === "present").length;
    return (
      heading(
        "EVERY SCOUT COUNTS",
        "Who’s here?",
        `Sessions, hikes, and events · ${year}`,
      ) +
      `<div class="attendance-layout"><section class="panel activity-picker"><div class="panel-heading"><h2>Choose an activity</h2></div><label>Activity<select id="activity-select">${option("", "Select an activity", activityId)}${[
        ...data.activities,
      ]
        .sort((a, b) => b.occurred_on.localeCompare(a.occurred_on))
        .map((a) => option(a.id, `${a.occurred_on} · ${a.title}`, activityId))
        .join(
          "",
        )}</select></label><details class="create-activity-details" ${active ? "" : "open"}><summary>Create a new activity</summary><form data-form="activity"><fieldset ${writeDisabled() ? "disabled" : ""}><label>Name<input name="title" placeholder="Saturday den meeting" maxlength="200" required></label><div class="form-row"><label>Type<select name="kind"><option value="session">Session</option><option value="hike">Hike</option><option value="event">Event</option></select></label>${dateInput()}</div>${saveButton("Create activity")}</fieldset>${writerNote()}</form></details></section><section class="panel attendance-sheet">${
        active
          ? `<div class="panel-heading"><div><p class="eyebrow">${h(active.kind)} · ${h(dateLabel(active.occurred_on))}</p><h2>${h(active.title)}</h2>${active.event_id?`<a class="back-button" href="${h(appLink('/planner?event='+active.event_id,'leader',{year,den}))}">${backLabel("Return to meeting plan and review completions")}</a>`:""}</div><span class="pill">${present} present in ${den ? h(denName(den)) : search ? "this list" : "the pack"}${[...attendanceDraft.keys()].some((k) => k.startsWith(activityId + ":")) ? " · Unsaved changes" : ""}</span></div><p class="muted">Attendance is dated ${h(dateLabel(active.occurred_on))}. ${beta ? "Saved attendees are checked. Check missing attendees to add them; uncheck a saved attendee to mark them absent when you save. Untouched scouts keep their recorded status." : "Unrecorded scouts are shown separately from absent scouts."}</p><form data-form="attendance"><div class="selection-bar"><strong role="status">${scouts.filter((s) => attendanceSelected.has(s.id)).length} selected</strong><button type="button" class="button secondary" data-action="attendance-select-all" ${writeDisabled() ? "disabled" : ""}>Select all</button><button type="button" class="button secondary" data-action="attendance-clear" ${writeDisabled() ? "disabled" : ""}>Clear</button></div><div class="scout-choice-list">${scouts.map((s) => {
                const current = existing.find((r) => r.scout_id === s.id);
                const status = attendanceDraft.get(`${activityId}:${s.id}`)?.status ?? current?.status ?? "";
                return `<div class="attendance-scout-row">${touchScout(s, "attendance", `${denName(s.den)} · ${beta && status !== (current?.status || "") ? `${current?.status ? `Saved: ${statusLabel(current.status)}` : "Not recorded"} → ${statusLabel(status)} · Unsaved change` : status ? `${beta ? "Saved: " : ""}${statusLabel(status)}` : "Not recorded"}`)}<label class="attendance-state"><span class="sr-only">Attendance for ${h(s.scout_name)}</span><select aria-label="Attendance for ${h(s.scout_name)}" data-attendance="${h(s.id)}" ${writeDisabled() ? "disabled" : ""}>${option("", "Not recorded", status)}${["present", "absent", "excused"].map((v) => option(v, v === "present" ? "Attending" : statusLabel(v), status)).join("")}</select></label></div>`;
              }).join("")}</div>${!scouts.length ? empty("No scouts match these filters", "Try another den or search.") : ""}<div class="touch-toolbar">${beta && search && attendanceChanges().some((change) => !scouts.some((s) => s.id === change.scout.id)) ? '<p class="form-note">Your changes to scouts hidden by search are also included when saving.</p>' : ""}<div class="form-row"><label>For selected scouts<select id="attendance-bulk-status">${["present","absent","excused"].map((v) => option(v,v === "present" ? "Attending" : statusLabel(v),attendanceBulkStatus)).join("")}</select></label><button type="button" class="button secondary" data-action="apply-attendance" ${writeDisabled() || !scouts.some((s) => attendanceSelected.has(s.id)) ? "disabled" : ""}>Apply to selected</button></div><div class="form-footer"><button class="button secondary" type="button" data-action="all-present" ${writeDisabled() ? "disabled" : ""}>Mark displayed scouts present</button>${beta ? `<button class="button primary" type="submit" ${writeDisabled() || !attendanceChanges().length ? "disabled" : ""}>Save attendance · ${attendanceChanges().length} ${attendanceChanges().length === 1 ? "change" : "changes"}</button>` : saveButton("Save attendance")}</div></div>${writerNote()}</form>`
          : empty(
              "Choose a session, hike, or event",
              "Create an activity on the left, then record who attended.",
            )
      }</section></div>`
    );
  }
  function scoutsView() {
    return (
      heading(
        "GET TO KNOW YOUR DEN",
        "Scouts",
        "Every scout’s progress, registration, and equipment in one place.",
      ) +
      `<section class="panel"><div class="panel-heading"><h2>${den ? h(denName(den)) : "The pack"} <span class="count">${filtered().length}</span></h2><span class="muted">Select a scout to open their fieldbook</span></div><div class="table-wrap"><table><thead><tr><th>Scout</th><th>Active.com</th><th>Scouting.org</th><th>BSA number</th><th>Adventures earned</th><th>Badges waiting</th><th></th></tr></thead><tbody>${filtered()
        .map((s) => {
          const r = data.summary.find((r) => r.scout_id === s.id);
          return `<tr><td>${scoutLink(s)}</td><td>${tag(r?.active_registration || "unknown")}</td><td>${tag(r?.scouting_registration || "unknown")}</td><td><span class="bsa-number">${h(s.bsa_member_id || "Not recorded")}</span></td><td>${r?.earned_adventures || 0}</td><td>${r?.badges_to_deliver || 0}</td><td><a class="icon-link" href="#scout/${h(s.id)}" aria-label="Open ${h(s.scout_name)}">${icon("arrow")}</a></td></tr>`;
        })
        .join(
          "",
        )}</tbody></table></div>${!filtered().length ? empty("No scouts found", "Try changing the den or search.") : ""}</section>`
    );
  }
  function adventuresView() {
    const scouts = adventureRoster();
    const ranks = [...new Set(scouts.map((s) => denRank(s.den)).filter(Boolean))];
    if (!den && ranks.length > 1) return heading("WORK TOGETHER", "Adventures & badges", "Choose a den above to select scouts and record their progress.") + empty("Choose your den", "The den filter keeps completion choices relevant to your scouts.");
    if (!progressClassic) {
      const a = data.adventures.find(a=>a.id===adventureId);
      for(const s of scouts.filter(s=>adventureSelected.has(s.id))) if(a&&!adventureRevisions.has(`${a.id}:${s.id}`)) adventureRevisions.set(`${a.id}:${s.id}`,advancement(s,a)?.revision||0);
      return progressWizard(data,adventureRoster(),{step:wizardStep,action:adventureAction,adventure:adventureId,requirement:requirementCode,selected:adventureSelected,date:selectedDate,badge:badgeForm||(['webelos','arrow_of_light'].includes(a?.rank||'')?'pin':'belt_loop'),instructions:assignmentInstructions,due:assignmentDue,reason:correctionReason},writeDisabled());
    }
    const rank = denRank(den) || ranks[0];
    const roster = scouts.filter((s) => denRank(s.den) === rank);
    const selected = roster.filter((s) => adventureSelected.has(s.id));
    const targets = !beta && selected.length ? selected : roster;
    const options = data.adventures.filter((a) => a.rank === rank && targets.some((s) => needsAdventureAction(data,s,a,adventureAction))).sort(compareAdventures);
    let a = options.find((a) => a.id === adventureId);
    if (!a) { a = options[0]; adventureId = a?.id || ""; }
    if (a) for (const s of selected) { const key = `${a.id}:${s.id}`; if (!adventureRevisions.has(key)) adventureRevisions.set(key,advancement(s,a)?.revision || 0); }
    const requirementAction = adventureAction === "assign_requirement" ? "assign_requirement" : "record_requirement";
    const requirements = a?.requirements.filter((r) => targets.some((s) => needsAdventureAction(data,s,a!,requirementAction,r.code))) || [];
    if (!(adventureAction === "assign_requirement" && requirementCode === "*") && !requirements.some((r) => r.code === requirementCode)) requirementCode = requirements[0]?.code || "";
    const eligible = a ? selected.filter((s) => needsAdventureAction(data,s,a!,adventureAction,["record_requirement","assign_requirement"].includes(adventureAction) && requirementCode !== "*" ? requirementCode : undefined)) : [];
    return heading("SELECT SCOUTS, THEN RECORD THEIR NEXT STEP", "Little steps. Big adventures.", "Select scouts, then record completed work or assign a requirement to their parents.", `<button class="button secondary" data-action="progress-guided">Try guided view</button><a class="button secondary" href="#families">Parent assignments & messages</a>`) +
      `<section class="panel"><form data-form="adventure"><div class="selection-bar"><strong role="status">${selected.length} selected</strong><button type="button" class="button secondary" data-action="adventure-select-all" ${writeDisabled() ? "disabled" : ""}>Select all</button><button type="button" class="button secondary" data-action="adventure-clear" ${writeDisabled() ? "disabled" : ""}>Clear</button></div><div class="scout-choice-list adventure-scouts">${roster.map((s) => {
        const state = a && advancement(s,a);
        const completed = a ? data.progress.filter((p) => p.scout_id === s.id && p.adventure_id === a!.id).length : 0;
        return touchScout(s,"adventure",a ? `${denName(s.den)} · ${state?.earned_on ? "Earned" : `${completed} / ${a.requirements.length} requirements recorded`}${state?.badge_delivered_on ? " · Badge received" : ""}` : denName(s.den));
      }).join("")}</div>
      <fieldset class="completion-controls" ${writeDisabled() ? "disabled" : ""}><label>What happened?<select name="adventure_action" id="adventure-action">${["record_requirement","assign_requirement","earn_adventure","deliver_badge"].map((action) => option(action,{record_requirement:"Complete a requirement",assign_requirement:"Assign to parents",earn_adventure:"Mark adventure earned",deliver_badge:"Hand out an earned badge"}[action]!,adventureAction)).join("")}</select></label>
      <label>Adventure<select id="adventure-select" required>${options.length ? options.map((v) => option(v.id,`${v.catalog_context?.adventure_type === "Required (Core)" ? "Required" : v.catalog_context?.adventure_type === "Elective" ? "Elective" : rankName(v.rank)} · ${v.name}`,adventureId)).join("") : '<option value="">No remaining adventures for this action</option>'}</select></label>
      ${a ? `<div class="adventure-art-title">${badgeArt(a)}<strong>${h(a.name)}</strong></div>` : ''}
      <label id="requirement-field" ${["record_requirement","assign_requirement"].includes(adventureAction) ? "" : "hidden"}>Requirement<select name="requirement_code" ${["record_requirement","assign_requirement"].includes(adventureAction) ? "required" : ""}>${adventureAction === "assign_requirement" ? option("*","All remaining requirements in this adventure",requirementCode) : ""}${requirements.map((r) => option(r.code,`${r.code}. ${r.description.slice(0,65)} · ${targets.filter((s) => needsAdventureAction(data,s,a!,requirementAction,r.code)).length} need this`,requirementCode)).join("")}</select></label>
      ${["record_requirement","assign_requirement"].includes(adventureAction) && requirements.find((r) => r.code === requirementCode) ? `<p class="form-note">${h(requirements.find((r) => r.code === requirementCode)!.description)}</p>` : ""}
      <label id="badge-field" ${adventureAction === "deliver_badge" ? "" : "hidden"}>Badge type<select name="badge_form">${option("belt_loop","Belt loop",badgeForm || (["webelos","arrow_of_light"].includes(rank) ? "pin" : "belt_loop"))}${option("pin","Pin",badgeForm || (["webelos","arrow_of_light"].includes(rank) ? "pin" : "belt_loop"))}</select></label>${dateInput("occurred_on",selectedDate,adventureAction === "assign_requirement" ? "Assigned on" : "Date")}${adventureAction === "assign_requirement" ? `<label>Due date (optional)<input type="date" name="due_on" min="${h(selectedDate)}" value="${h(assignmentDue)}"></label><label>Instructions for parents<textarea name="instructions" maxlength="2000" placeholder="What should the family do at home?">${h(assignmentInstructions)}</textarea></label><p class="form-note">Appears in the Parents Portal as To do. “All remaining requirements” creates one task per outstanding requirement. Parents submit a completion date; a leader reviews it before progress changes.</p>` : ""}
      <p class="form-note" id="award-note" ${adventureAction === "earn_adventure" ? "" : "hidden"}>Marking an adventure earned completes all remaining requirements on this date. Earlier completion dates stay as recorded. Handing out the physical badge is recorded separately.</p>
      ${a?.readiness_mode === "leader_review" ? `<div class="field-note warm"><p><strong>Leader review required.</strong> ${h(a.catalog_context?.completion_options || "Review official completion conditions.")} ${h(a.catalog_context?.notes || "")}</p></div>` : ""}
      <div class="touch-toolbar"><p role="status">${selected.length ? `${eligible.length} of ${selected.length} selected scouts will be updated. Already completed work is skipped.` : "Select scouts above to record a completion."}</p><button class="button primary" type="submit" ${writeDisabled() || !eligible.length ? "disabled" : ""}>${icon("check")}${adventureAction === "assign_requirement" ? "Assign to selected families" : "Record for selected scouts"}</button></div></fieldset>${writerNote()}</form>
      ${a ? `<details class="requirements-details"><summary>Read all requirements and official guidance</summary><h3>${h(a.name)}</h3><p><a href="${h(safeSource(a.source_url))}" target="_blank" rel="noopener noreferrer">Official requirements</a></p><ol class="requirements">${a.requirements.map((r) => `<li><span class="requirement-number">${h(r.code)}</span><p>${h(r.description)}</p></li>`).join("")}</ol></details>` : empty("No pending choices", "Try another action. Earned adventures with undelivered badges appear under Hand out an earned badge.")}</section>`;
  }
  function familiesView(){
    if(v2){
      const scouts=activeScouts().filter(s=>!den||s.den===den),id=route().id;
      if(!id)return familyWorkCards(data,scouts,familySearch);
      const scout=scouts.find(s=>s.id===id);
      if(!scout)return empty('Scout unavailable','Choose a scout from the current den.',`<a class="back-button" href="#families">${backLabel("Choose a scout")}</a>`);
      const row=familyWorkOverview(data,[scout])[0];
      return `<a class="back-link back-button" href="#families">${backLabel("Choose another scout")}</a><div class="family-review-heading">${v2Portrait(data,scout)}${heading('FAMILY WORK',scout.scout_name||'Scout',`${row.activeAssigned} active home tasks · ${row.totalAssigned} total assignments`)}</div><div class="family-selected-status">${familyWorkStatus(row)}</div>${leaderFamilyPanel(data,scout,writeDisabled(),familyDrafts,true)}`;
    }
    const scouts=filtered();if(!scouts.some(s=>s.id===familyScoutId))familyScoutId=scouts[0]?.id||"";
    const scout=scouts.find(s=>s.id===familyScoutId),ids=new Set(scouts.map(s=>s.id));
    const reviews=data.assignments.filter(a=>ids.has(a.scout_id)&&a.status==='submitted').length,unread=data.familyMessages.filter(m=>ids.has(m.scout_id)&&m.unread).length;
    return heading('HOME AND DEN, WORKING TOGETHER','Families & messages',`${reviews} parent submissions to review · ${unread} unread messages`)+`<div class="family-inbox-summary">${scouts.map(s=>{const r=data.assignments.filter(a=>a.scout_id===s.id&&a.status==='submitted').length,u=data.familyMessages.filter(m=>m.scout_id===s.id&&m.unread).length;return r||u?`<button class="button secondary" data-action="family-open" data-scout="${h(s.id)}">${h(s.scout_name)} · ${r} to review · ${u} unread</button>`:'';}).join('')}</div><label class="family-scout-picker">Family<select id="family-scout">${scouts.map(s=>option(s.id,s.scout_name||'Scout',familyScoutId)).join('')}</select></label>`+(scout?leaderFamilyPanel(data,scout,writeDisabled(),familyDrafts):empty('No families match','Choose another den or search.'));
  }
  function registrationForm(s: Scout, platform: string) {
    const r = registration(s, platform);
    return `<section class="panel"><div class="panel-heading"><h2>${h(platform === "active.com" ? "Active.com" : "Scouting.org")}</h2>${tag(r?.status || "unknown")}</div>${data.registrationReports?.some(v=>v.scout_id===s.id&&v.platform===platform)&&r?.status!=="confirmed"?'<p class="notice">Parent reports registration submitted — awaiting your verification.</p>':""}${platform === "scouting.org" ? `<div class="detail-row"><span>BSA member number</span><strong class="bsa-number">${h(s.bsa_member_id || "Not recorded")}</strong></div>` : ""}<p class="muted">${r ? `Last recorded ${h(dateLabel(r.occurred_on))}.` : "No registration verification recorded for this year."}</p><form data-form="registration" data-platform="${platform}" data-scout="${h(s.id)}"><fieldset ${writeDisabled() ? "disabled" : ""}><label>Registration status<select name="status">${["unknown", "confirmed", "not_registered"].map((v) => option(v, statusLabel(v), r?.status || "unknown")).join("")}</select></label>${dateInput()}${saveButton("Save registration")}</fieldset>${writerNote()}</form></section>`;
  }
  function profileAdventures(s: Scout) {
    return `<section class="panel"><div class="panel-heading"><h2>Adventure fieldbook</h2><label class="compact-label">Date for quick completions<input id="quick-date" type="date" max="${todayLA()}" value="${selectedDate}" required></label></div>${data.adventures
      .filter((a) => a.rank === denRank(s.den) || data.advancement.some(v => v.scout_id === s.id && v.adventure_id === a.id))
      .sort(compareAdventures)
      .map((a) => {
        const v = advancement(s, a);
        const completed = data.progress.filter(
          (p) => p.scout_id === s.id && p.adventure_id === a.id,
        );
        return `<details class="scout-adventure" id="adventure-${h(a.id)}"><summary><span>${badgeArt(a)}${h(a.name)}<small>${a.requirements.length} requirements · ${completed.length} recorded</small></span>${v?.badge_delivered_on ? tag("confirmed", "Badge received") : v?.earned_on ? tag("pending", "Earned · badge waiting") : tag("neutral", `${completed.length} / ${a.requirements.length}`)}</summary><div class="scout-adventure-body">${a.readiness_mode === "leader_review" ? `<p class="form-note">Leader review: ${h(a.catalog_context?.completion_options || "Check official conditions.")}${a.catalog_context?.notes ? `<br>${h(a.catalog_context.notes)}` : ""}</p>` : ""}<ul class="requirement-list">${a.requirements
          .map((r) => {
            const p = completed.find((p) => p.requirement_code === r.code);
            return `<li><span class="requirement-number ${p ? "done" : ""}">${p ? icon("check") : h(r.code)}</span><div><p>${h(r.description)}</p><small>${p ? `${h(dateLabel(p.completed_on))}${p.completion_source === "award" ? " · Completed with the award" : ""}` : "Not recorded"}</small>${p?valueAttribution(data.attribution,"pack_requirement_progress",{scout_id:s.id,adventure_id:a.id,requirement_code:r.code,scouting_year:year},"completed_on"):""}</div>${canRecord && !v?.earned_on ? `<button class="text-button" data-action="requirement" data-scout="${h(s.id)}" data-adventure="${h(a.id)}" data-code="${h(r.code)}" data-status="${p ? "not_completed" : "completed"}">${p ? "Undo" : "Complete"}</button>` : ""}</li>`;
          })
          .join(
            "",
          )}</ul><div class="adventure-dates">${v?.earned_on ? `<p>Earned <strong>${h(dateLabel(v.earned_on))}</strong></p>` : ""}${v?.badge_delivered_on ? `<p>Badge received <strong>${h(dateLabel(v.badge_delivered_on))}</strong> · ${v.badge_form === "pin" ? "Pin" : "Belt loop"}</p>` : ""}</div>${canRecord ? `<form data-form="single-adventure" data-scout="${h(s.id)}" data-adventure="${h(a.id)}"><fieldset class="form-row" ${writeDisabled() ? "disabled" : ""}><label>Record<select name="action">${!v?.earned_on ? '<option value="earn_adventure">Adventure earned</option>' : !v.badge_delivered_on ? '<option value="deliver_badge">Badge handed out</option><option value="revoke_adventure">Correct an earned award</option>' : '<option value="deliver_badge">Correct badge date or type</option><option value="retract_badge_delivery">Correct a mistaken delivery</option>'}</select></label>${dateInput()}<label>Badge type<select name="badge_form">${option("belt_loop", "Belt loop", v?.badge_form || "belt_loop")}${option("pin", "Pin", v?.badge_form || "belt_loop")}</select></label><label>Correction reason, if applicable<input name="reason" maxlength="500" placeholder="Why this record needs correcting"></label>${saveButton("Record")}</fieldset><p class="form-note">Earning completes all requirements; earlier dates are preserved. To correct a requirement after earning, correct any mistaken delivery and revoke the award first. The original entries remain in history.</p></form>` : ""}<a class="text-link" href="${h(safeSource(a.source_url))}" target="_blank" rel="noopener noreferrer">Official requirements ${icon("arrow")}</a></div></details>`;
      })
      .join("")}</section>`;
  }
  const gearActions: Record<string, string> = {
    give_free_item: "Give a free item",
    issue_loan: "Issue a loan",
    return_loan: "Record a return",
    report_loan_loss: "Record a lost item and charge",
    pay_loan_loss: "Record payment for a lost item",
    request_purchase: "Request an additional item",
    set_purchase_price: "Record or change a purchase price",
    pay_purchase: "Record a purchase payment",
    deliver_purchase: "Hand out a purchased item",
    review_shirt_history: "Review free-shirt history",
    record_historical_shirt: "Record a past free shirt",
    void_equipment_event: "Correct an equipment entry",
  };
  function equipmentForm(s: Scout) {
    const action = equipmentAction;
    let targets: Equipment[] = [];
    if (["return_loan", "report_loan_loss"].includes(action))
      targets = data.loans.filter(
        (l) => l.scout_id === s.id && (l.outstanding_quantity || 0) > 0,
      );
    if (action === "pay_loan_loss")
      targets = data.losses.filter(
        (l) => l.scout_id === s.id && (l.balance_minor || 0) > 0,
      );
    if (
      ["set_purchase_price", "pay_purchase", "deliver_purchase"].includes(
        action,
      )
    )
      targets = data.purchases.filter(
        (p) =>
          p.scout_id === s.id &&
          (action === "deliver_purchase"
            ? (p.unfulfilled_quantity || 0) > 0
            : action === "pay_purchase"
              ? p.balance_minor == null || p.balance_minor > 0
              : true),
      );
    if (action === "void_equipment_event")
      targets = data.events.filter(
        (e) =>
          e.scout_id === s.id &&
          !e.voided &&
          e.action !== "void_equipment_event",
      );
    const needsTarget = [
      "return_loan",
      "report_loan_loss",
      "pay_loan_loss",
      "set_purchase_price",
      "pay_purchase",
      "deliver_purchase",
      "void_equipment_event",
    ].includes(action);
    const target = targets.find((t) => t.id === equipmentTarget) || targets[0];
    const needsQty = [
      "give_free_item",
      "issue_loan",
      "return_loan",
      "report_loan_loss",
      "request_purchase",
      "deliver_purchase",
    ].includes(action);
    const needsMoney = [
      "report_loan_loss",
      "pay_loan_loss",
      "request_purchase",
      "set_purchase_price",
      "pay_purchase",
    ].includes(action);
    const needsItem = [
      "give_free_item",
      "issue_loan",
      "request_purchase",
    ].includes(action);
    const items =
      action === "issue_loan"
        ? ["neckerchief", "slider"]
        : action === "give_free_item"
          ? ["tshirt", "first_aid_kit", "lion_book", "tiger_book"]
          : ["tshirt", "neckerchief", "slider", "lion_book", "tiger_book"];
    const history = eligibility(s);
    return `<section class="panel" id="equipment-form"><div class="panel-heading"><h2>Record equipment</h2>${tag(history?.free_shirt_eligibility || "unknown", `Free shirt: ${statusLabel(history?.free_shirt_eligibility || "unknown")}`)}</div><form data-form="equipment" data-scout="${h(s.id)}"><fieldset ${writeDisabled() ? "disabled" : ""}><label>What happened?<select id="equipment-action" name="action">${Object.entries(
      gearActions,
    )
      .map(([value, label]) => option(value, label, action))
      .join(
        "",
      )}</select></label>${["review_shirt_history", "record_historical_shirt"].includes(action) ? `<div class="field-note"><p>${action === "review_shirt_history" ? `Confirm you have checked free-shirt records for ${h(year)} and the previous program year. Add known past free shirts before confirming the history.` : "Record a known past free shirt using the program year above and the actual issue date. Include the source of this information."}</p></div>` : ""}${needsTarget ? `<label>Related item<select name="target_id" id="equipment-target" required>${targets.map((t) => option(t.id, `${dateLabel(t.occurred_on)} · ${itemName(t.item)}${action === "void_equipment_event" ? ` · ${eventName(t.action)}` : ` · ${t.quantity || 1} issued`}${t.outstanding_quantity !== undefined ? ` · ${t.outstanding_quantity} outstanding` : ""}${t.balance_minor !== undefined ? ` · ${t.balance_minor == null ? "Price not recorded" : moneyLabel(t.balance_minor, t.price_currency || t.currency) + " unpaid"}` : ""}`, target?.id || "")).join("")}</select></label>${!targets.length ? '<p class="form-note">There are no matching entries for this scout in the selected program year.</p>' : ""}` : ""}<div class="form-row">${needsItem ? `<label>Item<select name="item">${items.map((i, n) => option(i, itemName(i), items[0])).join("")}</select></label>` : ""}${needsQty ? '<label>Quantity<input name="quantity" type="number" min="1" max="100" value="1" required></label>' : ""}${["give_free_item", "request_purchase"].includes(action) ? '<label>T-shirt size, if applicable<input name="size" maxlength="40" placeholder="e.g. Youth medium"></label>' : ""}${dateInput()}</div>${action === "give_free_item" ? `<label>Rank at issue, for a free book<select name="rank_at_issue"><option value="">Select only when giving a book</option><option value="lion">Lion</option><option value="tiger">Tiger</option></select></label><p class="form-note">A free shirt requires reviewed history and no free shirt in the current or previous year. Free books are for Lions and Tigers only.</p>` : ""}${needsMoney ? `<div class="form-row"><label>${action === "request_purchase" ? "Total price, if known" : action === "report_loan_loss" ? "Lost-item charge" : "Total price or payment amount"}<input name="amount" inputmode="decimal" placeholder="0.00" ${action === "request_purchase" ? "" : "required"}></label><label>Currency<input name="currency" value="${h(target?.price_currency || target?.currency || "USD")}" pattern="[A-Z]{3}" maxlength="3" required></label></div><p class="form-note">Enter the total amount, not the per-item price. Payments are recorded here after being made elsewhere; this portal does not collect money.</p>` : ""}<label>${["review_shirt_history", "record_historical_shirt", "void_equipment_event"].includes(action) ? "Source or correction reason" : "Note (optional)"}<textarea name="note" maxlength="500" rows="2" ${["review_shirt_history", "record_historical_shirt", "void_equipment_event"].includes(action) ? "required" : ""}></textarea></label>${action === "void_equipment_event" ? '<p class="form-note">This corrects a record and keeps its history. Correct dependent payments or deliveries first. It does not mean a physical item was returned.</p>' : ""}${saveButton("Save equipment record")}</fieldset>${writerNote()}</form></section>`;
  }
  function equipmentHistory(s: Scout) {
    const rows = data.events
      .filter((e) => e.scout_id === s.id)
      .sort((a, b) => b.revision - a.revision);
    return `<section class="panel"><div class="panel-heading"><h2>Equipment history</h2><span class="muted">${h(year)}</span></div>${rows.length ? `<div class="table-wrap"><table><thead><tr><th>Date</th><th>What happened</th><th>Item</th><th>Amount</th><th>Note</th></tr></thead><tbody>${rows.map((e) => `<tr class="${e.voided ? "voided" : ""}"><td>${h(dateLabel(e.occurred_on))}</td><td>${h(eventName(e.action))}${e.voided ? "<small>Corrected entry · history retained</small>" : ""}</td><td>${h(itemName(e.item))}${e.quantity ? ` × ${e.quantity}` : ""}${e.size ? `<small>${h(e.size)}</small>` : ""}</td><td>${e.amount_minor != null ? h(moneyLabel(e.amount_minor, e.currency)) : "—"}</td><td class="wrap-cell">${h(e.note || "—")}</td></tr>`).join("")}</tbody></table></div>` : empty("No equipment recorded yet", "Past distributions and loans have not been imported. Record only what you know happened.")}</section>`;
  }
  const profilePhotos = new Map<string,{scout_id:string;kind:string;image:string}[]>();
  const loadingPhotos = new Set<string>();
  function profileView(id: string) {
    if(profileTab==='photos' && service.loadPhotos && !profilePhotos.has(id) && !loadingPhotos.has(id)){
      const token=epoch; loadingPhotos.add(id);
      void service.loadPhotos(id).then(photos=>{if(!disposed&&token===epoch){profilePhotos.set(id,photos);render();}}).catch(()=>{if(!disposed&&token===epoch){profilePhotos.set(id,[]);setNotice('Photo loading failed. Refresh and try again.','error');}}).finally(()=>loadingPhotos.delete(id));
    }
    const s = scoutById(id);
    if (!s)
      return empty(
        "Scout not found",
        "Return to the scout list to choose a record.",
        `<a class="back-button" href="#scouts">${backLabel("Back to scouts")}</a>`,
      );
    const summary = data.summary.find((r) => r.scout_id === s.id);
    return `<a href="#scouts" class="back-link back-button">${backLabel("Back to scouts")}</a>${heading(denName(s.den), s.scout_name || "Scout fieldbook", `${s.grade ? `${s.grade} · ` : ""}${year}`)}${v2?`<div class="v2-profile-actions"><button class="button primary" data-action="v2-scout-progress" data-scout="${h(s.id)}" ${writeDisabled()?'disabled':''}>Record progress for ${h(s.scout_name)}</button><button class="button secondary" data-action="v2-scout-badges" data-scout="${h(s.id)}" ${writeDisabled()?'disabled':''}>Hand out a badge</button><button class="button secondary" data-action="profile-tab" data-tab="family">Message family</button></div>`:''}<div class="profile-tabs" role="navigation" aria-label="Scout sections">${["overview", "adventures", "equipment", "registration", "family", "photos", "history"].map((t) => `<button class="${profileTab === t ? "active" : ""}" data-action="profile-tab" data-tab="${t}">${t[0].toUpperCase() + t.slice(1)}</button>`).join("")}</div>${
      profileTab === "photos" ? `<section class="panel"><h2>Scout and family photos</h2><p><a href="/images?den=${h(s.den||'')}">Open the den gallery →</a></p><div class="profile-photo-grid">${['scout','family'].map(kind=>{const photo=(profilePhotos.get(s.id)||data.familyPhotos)?.find(p=>p.scout_id===s.id&&p.kind===kind);return `<div><h3>${kind==='scout'?'Scout portrait':'Family photo'}</h3>${photo?`<img class="profile-photo" src="${h(photo.image)}" alt="${h(s.scout_name)} ${kind} photo">`:`<p>No ${kind} photo yet.</p>`}</div>`;}).join('')}</div></section>` : profileTab === "history" ? scoutValueHistory(data,s) : profileTab === "family" ? leaderFamilyPanel(data,s,writeDisabled(),familyDrafts,v2) : profileTab === "registration"
        ? `<div class="two-column">${registrationForm(s, "active.com")}${registrationForm(s, "scouting.org")}</div>`
        : profileTab === "adventures"
          ? profileAdventures(s)
          : profileTab === "equipment"
            ? `${equipmentForm(s)}${equipmentHistory(s)}`
            : `<div class="stats">${stat(summary?.earned_adventures || 0, "Adventures earned", "This program year")}${stat(summary?.badges_to_deliver || 0, "Badges waiting", "Earned, not yet handed out", "accent")}${stat(summary?.outstanding_loan_items || 0, "Items on loan", "Recorded outstanding quantities")}${stat(summary?.unfulfilled_purchase_requests || 0, "Purchase requests", "Still need items handed out")}</div><div class="two-column"><section class="panel"><div class="panel-heading"><h2>Registration</h2><button class="text-button" data-action="profile-tab" data-tab="registration">${canRecord ? "Update" : "View"} ${icon("arrow")}</button></div><div class="detail-row"><span>Active.com</span>${tag(summary?.active_registration || "unknown")}</div><div class="detail-row"><span>Scouting.org</span>${tag(summary?.scouting_registration || "unknown")}</div><div class="detail-row"><span>BSA member number</span><strong class="bsa-number">${h(s.bsa_member_id || "Not recorded")}</strong></div><p class="form-note">Both registrations are required. “Needs verification” means no confirmation is recorded.</p></section><section class="panel"><div class="panel-heading"><h2>Free T-shirt</h2>${tag(eligibility(s)?.free_shirt_eligibility || "unknown")}</div><p>${eligibility(s)?.free_shirt_eligibility === "eligible" ? "History has been reviewed and no free shirt is recorded in the current or previous year." : eligibility(s)?.free_shirt_eligibility === "ineligible" ? "A free shirt is recorded in the current or previous year. Additional shirts may be purchased." : "Review the current and previous year’s shirt history before issuing a free shirt."}</p><button class="text-button" data-action="profile-tab" data-tab="equipment">Open equipment ${icon("arrow")}</button></section></div><section class="panel"><div class="panel-heading"><h2>Recorded contacts</h2><span class="muted">Roster snapshot</span></div><div class="two-column contacts">${[
                1, 2,
              ]
                .map((n) => {
                  const p = s as unknown as Record<string, string | null>;
                  return `<div><h3>${h(p[`parent_${n}_name`] || `Parent ${n} · not recorded`)}</h3><p>${h(p[`parent_${n}_email`] || "Email not recorded")}</p><p>${phoneLink(p[`parent_${n}_phone`])}</p></div>`;
                })
                .join(
                  "",
                )}</div><details class="private-details"><summary>Birth date</summary><p>Birth date: ${h(dateLabel(s.birth_date))}</p></details><p class="form-note">For allergy or medical information, authorized den leaders must use Active.com. Do not enter health information in this website.</p></section>`
    }`;
  }
  function equipmentView() {
    const ids = new Set(filtered().map((s) => s.id));
    const loans = data.loans.filter(
        (e) => ids.has(e.scout_id) && (e.outstanding_quantity || 0) > 0,
      ),
      losses = data.losses.filter(
        (e) => ids.has(e.scout_id) && (e.balance_minor || 0) > 0,
      ),
      purchases = data.purchases.filter(
        (e) =>
          (ids.has(e.scout_id) && (e.unfulfilled_quantity || 0) > 0) ||
          (ids.has(e.scout_id) &&
            e.balance_minor != null &&
            e.balance_minor > 0),
      );
    const itemRows = (rows: Equipment[], kind: string) =>
      rows.length
        ? `<div class="table-wrap"><table><thead><tr><th>Scout</th><th>Item</th><th>${kind === "loans" ? "Outstanding" : kind === "losses" ? "Unpaid charge" : "To hand out / unpaid"}</th><th>Since</th><th></th></tr></thead><tbody>${rows
            .map((e) => {
              const s = scoutById(e.scout_id);
              return `<tr><td>${s ? scoutLink(s) : "Scout not found"}</td><td>${h(itemName(e.item))}${e.size ? `<small>${h(e.size)}</small>` : ""}</td><td>${kind === "loans" ? e.outstanding_quantity : kind === "losses" ? h(moneyLabel(e.balance_minor, e.currency)) : `${e.unfulfilled_quantity} to hand out<small>${h(e.balance_minor == null ? "Price not recorded" : moneyLabel(e.balance_minor, e.price_currency) + " unpaid")}</small>`}</td><td>${h(dateLabel(e.occurred_on))}</td><td><button class="text-button" data-action="open-equipment" data-scout="${h(e.scout_id)}">${canRecord ? "Manage" : "View"} ${icon("arrow")}</button></td></tr>`;
            })
            .join("")}</tbody></table></div>`
        : empty(
            kind === "loans"
              ? "No open loans recorded"
              : kind === "losses"
                ? "No unpaid loss charges recorded"
                : "No outstanding purchases recorded",
            "These lists reflect recorded history for the selected program year.",
          );
    return (
      heading(
        "READY FOR THE NEXT OUTING",
        "Equipped for adventure.",
        "Keep physical items, purchases, and payments clear and separate.",
      ) +
      `<div class="stats">${stat(
        loans.reduce((n, l) => n + (l.outstanding_quantity || 0), 0),
        "Items on loan",
        "Neckerchiefs and sliders",
      )}${stat(losses.length, "Loss charges unpaid", "Amounts stay in their own currency")}${stat(
        purchases.reduce((n, p) => n + (p.unfulfilled_quantity || 0), 0),
        "Items to hand out",
        "Payment and delivery are separate",
      )}${stat(data.eligibility.filter((e) => ids.has(e.scout_id) && e.free_shirt_eligibility === "unknown").length, "Shirt histories to review", "Before issuing a free T-shirt")}</div><section class="panel"><div class="panel-heading"><h2>Record an item for a scout</h2></div><label>Open their equipment fieldbook<select id="equipment-scout"><option value="">Choose a scout</option>${filtered()
        .map((s) => option(s.id, `${s.scout_name} · ${denName(s.den)}`, ""))
        .join(
          "",
        )}</select></label></section><section class="panel"><div class="panel-heading"><h2>Open loans</h2><span class="pill">${loans.length} records</span></div>${itemRows(loans, "loans")}</section><section class="panel"><div class="panel-heading"><h2>Additional items</h2></div>${itemRows(purchases, "purchases")}</section><section class="panel"><div class="panel-heading"><h2>Lost-item charges</h2></div>${itemRows(losses, "losses")}</section>`
    );
  }
  function followups() {
    const scouts = filtered(),
      ids = new Set(scouts.map((s) => s.id));
    const gaps = data.summary.filter(
      (r) =>
        ids.has(r.scout_id) &&
        (r.active_registration !== "confirmed" ||
          r.scouting_registration !== "confirmed"),
    );
    const badges = data.advancement.filter(
      (v) => ids.has(v.scout_id) && v.earned_on && !v.badge_delivered_on,
    );
    return (
      heading(
        "A FEW THINGS TO WRAP UP",
        "The follow-up list.",
        "Clear next steps, with unknown information kept separate from confirmed gaps.",
      ) +
      `<section class="panel"><div class="panel-heading"><h2>Registration to follow up</h2><span class="pill">${gaps.length} scouts</span></div>${gaps.length ? `<div class="table-wrap"><table><thead><tr><th>Scout</th><th>Active.com</th><th>Scouting.org</th><th></th></tr></thead><tbody>${gaps.map((r) => `<tr><td>${scoutLink(scoutById(r.scout_id)!)}</td><td>${tag(r.active_registration)}</td><td>${tag(r.scouting_registration)}</td><td><button class="text-button" data-action="open-registration" data-scout="${h(r.scout_id)}">${canRecord ? "Update" : "View"} ${icon("arrow")}</button></td></tr>`).join("")}</tbody></table></div>` : empty("All registrations are confirmed", "Both Active.com and Scouting.org are recorded for these scouts.")}</section><section class="panel"><div class="panel-heading"><h2>Badges ready to hand out</h2><span class="pill">${badges.length} badges</span></div>${badges.length ? `<div class="table-wrap"><table><thead><tr><th>Scout</th><th>Adventure</th><th>Earned</th><th></th></tr></thead><tbody>${badges.map((v) => `<tr><td>${scoutLink(scoutById(v.scout_id)!)}</td><td>${h(data.adventures.find((a) => a.id === v.adventure_id)?.name || "Adventure")}</td><td>${h(dateLabel(v.earned_on))}</td><td><button class="text-button" data-action="open-adventures" data-scout="${h(v.scout_id)}">${canRecord ? "Record delivery" : "View"} ${icon("arrow")}</button></td></tr>`).join("")}</tbody></table></div>` : empty("No badges waiting in the fieldbook", "Earned adventures appear here until the physical badge is handed out.")}</section><div class="field-note">${icon("bag")}<p>For open loans, lost-item charges, and additional purchases, visit <a href="#equipment">Equipment</a>.</p></div>`
    );
  }
  function nextView() {
    const dens = [...new Set(activeScouts().map((s) => s.den).filter((d): d is string => !!d))];
    const planningDen = den || (dens.length === 1 ? dens[0] : "");
    if (!planningDen) return heading("PLAN THE NEXT MEETING", "What’s next?", "Choose a den above to see its next adventures.") + empty("Choose your den", "Recommendations use the recorded progress of everyone in the den.");
    const plan = denRecommendations(data,planningDen);
    const saved = data.denPlans.find((p) => p.den === planningDen && p.scouting_year === year);
    const electives = plan.elective.filter((a) => plan.need(a).length > 0);
    const prioritiesFinished = saved?.adventure_ids.length === 2 && saved.adventure_ids.every((id) => { const a = plan.elective.find((a) => a.id === id); return !!a && plan.need(a).length === 0; });
    if (priorityDraft === null) { priorityDraft = new Set((saved?.adventure_ids || []).filter((id) => electives.some((a) => a.id === id))); priorityRevision = saved?.revision || 0; }
    const card = (a: Adventure, needs: number, requirements: { code:string; description:string; needed:number }[] = []) => `<article class="next-card"><p class="eyebrow">${h(a.catalog_context?.adventure_type || "Adventure")}</p><h3>${h(a.name)}</h3><p><strong>${needs} of ${plan.scouts.length}</strong> scouts need a recorded adventure completion.</p><progress max="${Math.max(1,plan.scouts.length)}" value="${plan.scouts.length-needs}" aria-label="${plan.scouts.length-needs} of ${plan.scouts.length} scouts have earned ${h(a.name)}"></progress>${requirements.length ? `<ul>${requirements.slice(0,3).map((r) => `<li>Requirement ${h(r.code)}: ${r.needed} scouts need a recorded completion.</li>`).join("")}</ul>` : ""}${a.readiness_mode === "leader_review" ? '<p class="form-note">Review the official completion conditions with a leader.</p>' : ""}<button class="button secondary" data-action="plan-adventure" data-id="${h(a.id)}">Open adventure</button></article>`;
    return heading("YOUR DEN’S NEXT ADVENTURE", `What’s next for ${denName(planningDen)}?`, `${year} · ${plan.scouts.length} scouts. Required adventures come first; recommendations prioritize the most scouts.`) +
      `<div class="field-note"><p><a href="/planner">Open the connected meeting planner →</a> Recommendations use recorded completions. Missing history means not recorded, so check with the den before repeating work. An adventure is complete here when it is recorded as earned.</p></div>${!plan.scouts.length ? empty("No scouts in this den", "Choose another den.") : !plan.required.length ? empty("Required adventure definitions unavailable", "The den needs required adventure definitions before recommendations can be made.") : plan.allRequiredEarned ? `<section class="panel"><h2>All required adventures are recorded as earned.</h2><p>${electives.length >= 2 ? prioritiesFinished ? "Both shared elective priorities are complete for everyone in the den. Choose another 2 elective adventures to prioritize." : "Choose 2 elective adventures to prioritize." : electives.length === 1 ? "One elective remains to work on." : "All elective adventures are recorded as earned too."}</p><form data-form="den-priorities" ${electives.length < 2 ? "hidden" : ""} data-den="${h(planningDen)}" data-revision="${priorityRevision}"><fieldset ${writeDisabled() ? "disabled" : ""}><div class="scout-choice-list">${electives.map((a) => `<label class="scout-choice ${priorityDraft!.has(a.id) ? "is-selected" : ""}"><input type="checkbox" id="priority-${h(a.id)}" name="priority_ids" value="${h(a.id)}" ${priorityDraft!.has(a.id) ? "checked" : ""}><span><strong>${h(a.name)}</strong><small>${plan.need(a).length} of ${plan.scouts.length} scouts need this adventure</small></span><span class="choice-check" aria-hidden="true">${priorityDraft!.has(a.id) ? "✓" : "+"}</span></label>`).join("")}</div><div class="touch-toolbar"><p role="status">${priorityDraft.size} of 2 elective priorities selected. Shared with leaders for this den and program year.</p><button class="button primary" type="submit" ${writeDisabled() || priorityDraft.size !== 2 ? "disabled" : ""}>Save elective priorities</button></div></fieldset>${writerNote()}</form>${!electives.length ? empty("All electives are recorded as earned too", "There are no remaining elective adventures in this catalog.") : ""}</section><div class="next-grid">${electives.filter((a) => electives.length < 2 || saved?.adventure_ids.includes(a.id)).map((a) => card(a,plan.need(a).length)).join("")}</div>` : `<section class="panel"><h2>Required adventures to work on next</h2><p>Start with the adventures needed by the largest group.</p><div class="next-grid">${plan.pending.slice(0,3).map((p) => card(p.adventure,p.scouts.length,p.requirements)).join("")}</div>${plan.pending.length > 3 ? `<details><summary>See all ${plan.pending.length} remaining required adventures</summary><div class="next-grid">${plan.pending.slice(3).map((p) => card(p.adventure,p.scouts.length,p.requirements)).join("")}</div></details>` : ""}</section>`}`;
  }
  function inventoryView() {
    const items = data.inventory.filter((i) => (!den || !i.den || i.den === den) && (!inventoryCategory || i.category === inventoryCategory) && (!inventorySearch || `${i.name} ${inventoryCategoryLabels[i.category] || i.category}`.toLowerCase().includes(inventorySearch.toLowerCase())))
      .sort((a, b) => inventoryCategories.indexOf(a.category as typeof inventoryCategories[number]) - inventoryCategories.indexOf(b.category as typeof inventoryCategories[number]) || a.name.localeCompare(b.name));
    const item = data.inventory.find((i) => i.id === inventoryItemId);
    const history = item ? data.inventoryEvents.filter((e) => e.item_id === item.id).sort((a, b) => b.revision - a.revision) : [];
    const known = items.filter((i) => i.quantity_on_hand !== null);
    const editor = addingInventory || item ? `<section class="panel" id="inventory-editor"><div class="panel-heading"><h2>${addingInventory ? "Add a stock item" : h(item!.name)}</h2><button class="text-button" data-action="close-inventory">Close</button></div><form data-form="inventory" data-item="${h(item?.id || "")}" data-revision="${item?.revision || 0}"><fieldset ${writeDisabled() ? "disabled" : ""}>
      ${addingInventory ? `<label>Item name<input name="name" maxlength="200" required></label><div class="form-row"><label>Den<select name="den">${option("", "Pack-wide", den)}${["0-Lions", "1-Tigers", "2-Wolves", "3-Bears", "4-Webelos", "5-AOL"].map((d) => option(d, denName(d), den)).join("")}</select></label><label>Category<select name="category">${inventoryCategories.map((c) => option(c, inventoryCategoryLabels[c], "other")).join("")}</select></label></div>` : `<p>Stock on hand: <strong>${item!.quantity_on_hand ?? "Unknown"}</strong> · ${h(item!.den ? denName(item!.den) : "Pack-wide")}</p><label>What changed?<select id="inventory-action" name="action">${["inventory_count", "inventory_receive", "inventory_issue"].map((a) => option(a, inventoryActionLabels[a], inventoryAction)).join("")}</select></label>`}
      <div class="form-row"><label>${addingInventory ? "Opening quantity (blank if unknown)" : inventoryAction === "inventory_count" ? "New counted total" : "Quantity received / issued"}<input type="number" name="quantity" min="${!addingInventory && inventoryAction !== "inventory_count" ? 1 : 0}" max="1000000" step="1" ${addingInventory ? "" : "required"}></label>${dateInput("occurred_on", todayLA())}</div>
      <label>Reason or source<textarea name="note" required maxlength="500" rows="2" placeholder="e.g. Physical count, donation, or supplies handed out"></textarea></label><p class="form-note">A count replaces the total. Received stock adds to it; issued stock subtracts from it. Count unknown quantities before adding or subtracting. Record stock changes separately from scout handouts.</p>${saveButton(addingInventory ? "Add stock item" : "Save stock change")}</fieldset>${writerNote()}</form>
      ${item ? `<h3>Stock history</h3><div class="table-wrap"><table><thead><tr><th>Date</th><th>Action</th><th>Quantity</th><th>Balance</th><th>Reason</th></tr></thead><tbody>${history.map((e) => `<tr><td>${h(dateLabel(e.occurred_on))}</td><td>${h(inventoryActionLabels[e.action] || e.action)}</td><td>${e.quantity ?? "Unknown"}</td><td>${e.quantity_after ?? "Unknown"}</td><td class="wrap-cell">${h(e.note)}</td></tr>`).join("")}</tbody></table></div>${item.source_context.source_filename ? `<p class="form-note">Source: ${h(item.source_context.source_filename)}, row ${h(item.source_context.source_row)}. Opening snapshot: ${h(item.source_context.snapshot_date || "Not recorded")}.</p>` : ""}` : ""}</section>` : "";
    return heading("READY FOR THE NEXT ADVENTURE", "Pack inventory.", "Stock on hand across program years: badges, books, neckerchiefs, sliders, and other supplies.", `<button class="button primary" data-action="new-inventory" ${writeDisabled() ? "disabled" : ""}>Add stock item</button>`) +
      `<div class="stats">${stat(items.length, "Stock items", "Separate variants stay separate")}${stat(known.reduce((n, i) => n + i.quantity_on_hand!, 0), "Units on hand", "Known quantities only")}${stat(known.filter((i) => i.quantity_on_hand === 0).length, "Out of stock", "Confirmed zero counts")}${stat(items.length - known.length, "Unknown counts", "Need a physical count", "accent")}</div>
      <div class="field-note">${icon("bag")}<p>Opening quantities come from the inventory sheet. Scout loans and badge handouts do not automatically change these balances. Record each stock receipt, issue, or physical count here; historical handouts have not been deducted again.</p></div>${editor}
      <section class="panel"><div class="panel-heading"><h2>Stock on hand</h2><label>Category<select id="inventory-category">${option("", "All categories", inventoryCategory)}${inventoryCategories.map((c) => option(c, inventoryCategoryLabels[c], inventoryCategory)).join("")}</select></label></div><div class="table-wrap"><table><thead><tr><th>Item</th><th>Den</th><th>Category</th><th>On hand</th><th>Last counted</th><th></th></tr></thead><tbody>${items.map((i) => `<tr><td class="wrap-cell">${h(i.name)}</td><td>${h(i.den ? denName(i.den) : "Pack-wide")}</td><td>${h(inventoryCategoryLabels[i.category] || i.category)}</td><td>${i.quantity_on_hand === null ? tag("neutral", "Unknown") : i.quantity_on_hand === 0 ? tag("warm", "0 · Out of stock") : i.quantity_on_hand}</td><td>${h(dateLabel(i.last_counted_on))}</td><td><button class="text-button" data-action="open-inventory-item" data-id="${h(i.id)}">${canRecord ? "View / update" : "View history"}</button></td></tr>`).join("")}</tbody></table></div>${items.length ? "" : empty("No inventory items match", "Try another den, category, or search.")}</section>`;
  }
  function render() {
    if (disposed) return;
    const focused = doc.activeElement as HTMLInputElement | null;
    const focusId = focused?.id;
    const selection =
      focused?.tagName === "INPUT" && focused.type === "search"
        ? focused.selectionStart
        : null;
    if (!approved) {
      root.innerHTML = loginScreen()+appFooter();
      if(!v2)decoratePrevious(root);
      return;
    }
    const { view, id } = route();
    const preservedView=captureView(root);saveContext(win,"leader",{year,den,child:""});const contextURL=new URL(win.location.href);contextURL.searchParams.set("year",year);if(den)contextURL.searchParams.set("den",den);else contextURL.searchParams.delete("den");win.history.replaceState(null,"",contextURL);
    const dens = [
      ...new Set([...activeScouts().map((s) => s.den), ...(view === "inventory" ? data.inventory.map((i) => i.den) : [])].filter((s): s is string => !!s)),
    ].sort();
    root.innerHTML = `<div class="app-layout"><aside class="sidebar"><a class="brand" href="#home">${packLogo}<span>PACKPILOT<small>LEADER FIELDBOOK</small></span></a><p class="nav-caption">THE FIELDBOOK</p><nav aria-label="Main navigation">${navigation(view)}</nav><div class="sidebar-note">${icon("compass")}<p>Small steps.<br>Great adventures.</p></div><div class="account"><span class="avatar">${h(initials(email))}</span><div><strong>${canRecord ? "Leader access" : "Read-only access"}</strong><small title="${h(email)}">${h(email)}</small></div><button class="icon-button" aria-label="Sign out" title="Sign out" data-action="logout">${icon("logout")}</button></div></aside><div class="main-layout"><header class="topbar"><span class="topbar-title">${view === "profile" ? "Scout fieldbook" : (labels[view] || "More")}</span><span class="today">${h(dateLabel(todayLA()))}</span><button class="icon-button" data-action="refresh" aria-label="Refresh records" title="Refresh records" ${busy || pending ? "disabled" : ""}>${icon("refresh")}</button></header><div class="filter-bar"><label class="search-field">${icon("search")}<span class="sr-only">${view === "inventory" ? "Search inventory" : "Search scouts"}</span><input type="search" id="global-search" placeholder="${view === "inventory" ? "Find an inventory item…" : "Find a scout…"}" value="${h(view === "inventory" ? inventorySearch : search)}" autocomplete="off"></label><label class="filter-field"><span>Den</span><select id="den-filter">${option("", "All dens", den)}${dens.map((d) => option(d, denName(d), den)).join("")}</select></label><label class="filter-field year-field"><span>Program year</span><input id="year-filter" ${busy || pending ? "disabled" : ""} value="${h(year)}" pattern="[0-9]{4}-[0-9]{2}" maxlength="7" aria-label="Program year, for example 2026-27"></label></div><main id="workspace" tabindex="-1">${!canRecord ? '<div class="read-only-banner">You can view the fieldbook. Recording access is managed by the pack administrator.</div>' : ""}${notice ? `<div class="notice ${h(noticeKind)}" tabindex="-1" role="${noticeKind === "error" ? "alert" : "status"}">${h(notice)}<button class="icon-button" data-action="dismiss" aria-label="Dismiss message">×</button></div>` : ""}${pending && !busy ? `<div class="notice error" role="alert"><span>The save was not confirmed. Retry safely to check and finish the same changes.</span><button class="button secondary" data-action="retry">Retry save</button></div>` : ""}${loading ? `<div class="loading-sheet" role="status">${icon("refresh")}Loading the fieldbook…</div>` : view === "home" ? (v2 ? v2Home : beta ? betaHome : renderHome)(data, v2?activeScouts().filter(s=>!den||s.den===den):filtered(), den, year) : v2 && view === "badges" ? v2Badges(data,activeScouts().filter(s=>!den||s.den===den),id,canRecord,badgeSearch) : v2 && view === "gear" ? v2Gear() : view === "more" && beta ? (v2?v2More(isAdmin):betaMore(isAdmin)) : view === "overview" ? overview() : view === "next" ? nextView() : view === "attendance" ? attendanceView() : view === "scouts" ? (v2?v2ScoutList(data,filtered()):scoutsView()) : view === "adventures" ? adventuresView() : view === "equipment" ? equipmentView() : view === "inventory" ? inventoryView() : view === "families" ? familiesView() : view === "followups" ? followups() : profileView(id)}<footer class="workspace-footer"><span>PACKPILOT · DO YOUR BEST</span><span>Dates reflect when things happened. History stays in the fieldbook.</span></footer></main></div></div>`;
    if(beta&&!v2){decorateBeta(root,view,hasDraft()&&!busy&&!pending,refreshedAt);root.querySelector('.beta-bottom-nav')?.remove();const shell=doc.createElement('header');shell.className='app-header';shell.innerHTML=accountBar('leader',email)+renderNavigation('leader',view==='profile'?'scouts':view,{year,den,child:''},isAdmin);root.prepend(shell);const footer=doc.createElement('div');footer.innerHTML=appFooter();root.querySelector('main#workspace')?.append(footer);}
    if(v2){
      const attendanceForm=root.querySelector<HTMLFormElement>('form[data-form=attendance]');if(attendanceForm)attendanceForm.dataset.reviewSummary=attendanceChanges().map(v=>`${v.scout.scout_name}: ${statusLabel(v.status)}`).join('\n');
      const main=root.querySelector<HTMLElement>('#workspace')!,filters=root.querySelector('.filter-bar')!;
      const header=doc.createElement('header');header.className='v2-header';
      header.innerHTML=`<a class="v2-brand" href="#home">${packLogo}<span>PackPilot <small>Fieldbook</small></span></a><details class="v2-context"><summary>${h(den?denName(den):'All dens')} · ${h(year)}</summary></details>`;
      if(service.assistant){
        header.insertAdjacentHTML('beforeend','<button class="assistant-header-button" data-action="assistant-open" aria-label="Ask AI">✦ Ask</button>');
        if(view==='home'&&!loading)main.querySelector('.page-heading')?.insertAdjacentHTML('afterend','<button class="assistant-launch" data-action="assistant-open"><span aria-hidden="true">✦</span><span><strong>Ask AI</strong><small>Ask a question or record an update</small></span><span aria-hidden="true">→</span></button>');
      }
      header.querySelector('details')!.append(filters);
      const wrapper=doc.createElement('div');wrapper.className='v2-portal';wrapper.append(header,main);root.replaceChildren(wrapper);
      for(const toggle of root.querySelectorAll('[data-action=progress-classic],[data-action=progress-guided]'))toggle.remove();
      root.classList.toggle('v2-focused',['adventures','attendance'].includes(view));
      if(['adventures','attendance'].includes(view))main.insertAdjacentHTML('afterbegin',`<a class="back-link back-button" href="#home">${backLabel("Today")}</a>`);
      main.insertAdjacentHTML('beforeend',`<div class="v2-account">${accountBar('leader',email)}${appFooter()}</div>`);
      decorateV2(root,'leader',['scouts','profile','badges'].includes(view)?'scouts':view==='home'?'home':'more',{year,den,child:''},true,!!service.assistant);
    }
    if(!v2)decoratePrevious(root);
    restoreView(root,preservedView);if(noticeKind==='error')root.querySelector<HTMLElement>('[role=alert]')?.focus({preventScroll:true});const task=(route()as any).item;if(task){const el=doc.getElementById(task);if(el&&root.contains(el)){const details=el.closest('details');if(details)details.open=true;el.classList.add('task-focus');el.setAttribute('tabindex','-1');el.scrollIntoView?.({block:'center'});}}
    for(const a of root.querySelectorAll<HTMLAnchorElement>('a[href^="/"]'))if(!a.href.includes('/oauth/')&&!a.href.includes('/parents'))a.setAttribute('href',appLink(a.getAttribute('href')!,"leader",{year,den}));
    // Set controlled select values explicitly after replacing the view, including
    // when an option list changes after selecting an activity or equipment action.
    for (const select of root.querySelectorAll<HTMLSelectElement>("select")) {
      const selected =
        select.querySelector<HTMLOptionElement>("option[selected]");
      if (selected) select.value = selected.value;
    }
    const enteringProgress = view === 'adventures' && lastRenderedView !== 'adventures';
    if (!loading) lastRenderedView = view;
    if (enteringProgress && !progressClassic) {
      const steps = root.querySelector<HTMLElement>('#record-progress-steps');
      steps?.focus({preventScroll:true});
      steps?.scrollIntoView?.({block:'start',behavior:'instant'});
    }
    if (focusId && !enteringProgress) {
      const next = doc.getElementById(focusId) as HTMLInputElement | null;
      next?.focus();
      if (selection != null && next?.type === "search")
        next.setSelectionRange(selection, selection);
    }
  }
  function safeError(err: unknown) {
    const e = err as { message?: string; code?: string };
    const message = e?.message || "";
    if (message === "Roster has not been imported")
      return "The roster has not been loaded yet. Ask the pack administrator to load it, then refresh.";
    if (/Revision conflict/.test(message))
      return "Someone updated these records. The latest values have been loaded; review them and save again.";
    if (/Recording access denied|42501/.test(message) || e?.code === "42501")
      return "Your access may have changed. Refresh your access before recording anything else.";
    const known: Record<string, string> = {
      "No parent access linked to this scout": "Ask the pack administrator to link a parent email for this scout before assigning home work or sending messages.",
      "Assignment changed; refresh and retry": "This assignment changed. Review the refreshed family records before trying again.",
      "Assignment unavailable": "This assignment is no longer available. Review the refreshed family records.",
      "Explain what the parent should revisit": "Add feedback explaining what the parent should revisit.",
      "Invalid assignment dates or instructions": "Check the assigned date, due date, and instructions. The due date cannot be before the assigned date.",
      "Inventory quantity is unknown; record a count first": "Count this item first; its stock quantity is unknown.",
      "Insufficient inventory stock": "There is not enough stock for this issue. Check the quantity or record a corrected physical count.",
      "Inventory date precedes latest record": "Use a date on or after the latest stock record.",
      "Inventory quantity limit exceeded": "The resulting stock quantity exceeds the supported limit.",
      "Shirt history must be reviewed before free issue":
        "Review the current and previous year’s shirt history before issuing a free shirt.",
      "Free shirt already issued within two-year interval":
        "A free shirt is already recorded in an adjacent program year. Additional shirts can be purchased.",
      "Free book requires matching Lion or Tiger rank at issue":
        "For a free Lion or Tiger book, choose the scout’s matching rank at the time of issue.",
      "Quantity exceeds outstanding loan":
        "That quantity is more than the items still on loan.",
      "Payment exceeds outstanding charge":
        "That payment is more than the outstanding lost-item charge.",
      "Payment exceeds purchase balance":
        "That payment is more than the outstanding purchase balance.",
      "Quantity exceeds unfulfilled purchase":
        "That is more than the quantity still to hand out.",
      "Known purchase price and matching payment currency required":
        "Record the purchase price first and use the same currency for its payment.",
      "Void dependent events first":
        "Correct the related returns, payments, or deliveries before correcting the original entry.",
      "Void payments before correcting price":
        "Correct the payment entries before correcting this price entry.",
      "Void dependent shirt issue first":
        "Correct the related free-shirt issue before correcting its history review.",
      "Earned date precedes recorded completion":
        "The earned date must be on or after the existing requirement completion dates.",
      "Delivery date precedes earned date":
        "The badge delivery date must be on or after the earned date.",
      "Retract badge delivery before revoking adventure":
        "Correct the badge delivery record before revoking this award.",
      "Revoke the earned adventure before correcting requirements":
        "Correct the earned award before changing its requirements.",
      "Adventure must be earned before delivery":
        "Record the adventure as earned before recording badge delivery.",
      "Adventure already earned; revoke before correcting":
        "This adventure is already earned. Review its existing record before correcting it.",
      "Event date precedes target":
        "Use a date on or after the original issue, request, or charge.",
    };
    if (known[message]) return known[message];
    if (e?.code)
      return "This change was not saved. Check its date, quantity, price, and related records, then try again.";
    return message &&
      !/fetch|network|JSON|token|rpc|supabase|postgres|column|constraint/i.test(
        message,
      )
      ? message
      : "We could not reach the fieldbook. Check your connection and retry.";
  }
  function clearAccess(message = "") {
    assistantPanel?.dispose();assistantPanel=null;
    epoch++;
    approved = false;
    canRecord = false;
    isAdmin = false;
    loading = false;
    busy = false;
    pending = null;
    den = "";
    search = "";
    inventoryItemId = ""; inventorySearch = ""; inventoryCategory = ""; addingInventory = false;
    data = emptyData();clearContext(win,"leader");
    familyMessageDrafts.clear();familyReviewDrafts.clear();assignmentInstructions="";assignmentDue="";
    attendanceDraft.clear(); attendanceRevisions.clear();
    attendanceSelected.clear(); adventureSelected.clear(); adventureRevisions.clear(); priorityDraft = null;
    error = message;
    render();
  }
  async function refreshAccess() {
    if (!approved || busy) return;
    try {
      const caps = await service.capabilities();
      if (!caps.approved) {
        clearAccess(
          "This account is no longer approved. Ask the pack administrator for access.",
        );
        return;
      }
      if (canRecord !== caps.can_record || isAdmin !== (caps.is_admin === true)) {
        canRecord = caps.can_record;
      isAdmin = caps.is_admin === true;
        render();
      }
    } catch {
      /* Database checks remain authoritative if this background check cannot complete. */
    }
  }
  async function load(applyDefaultDen = false) {
    const token = ++epoch;
    profilePhotos.clear();
    loading = true;
    render();
    try {
      const caps = await service.capabilities();
      if (token !== epoch || disposed) return;
      if (!caps.approved) {
        clearAccess(
          "This Google account is not approved. Ask the pack administrator for access.",
        );
        return;
      }
      canRecord = caps.can_record;
      isAdmin = caps.is_admin === true;
      const next = await service.load(year);
      if (token !== epoch || disposed) return;
      data = next;
      refreshedAt = new Intl.DateTimeFormat("en-US", {hour:"numeric",minute:"2-digit"}).format(new Date());
      if (beta && !activityId) activityId = data.activities.filter((a) => a.occurred_on === todayLA()).sort((a,b) => a.title.localeCompare(b.title))[0]?.id || "";
      if (applyDefaultDen&&!den) den = preferredDen(caps.default_den, data.scouts);
      syncAttendanceSelection();
      loading = false;
      render();
    } catch (err) {
      if (token !== epoch || disposed) return;
      loading = false;
      const e = err as { code?: string };
      if (e?.code === "42501" || e?.code === "PGRST301") {
        clearAccess(
          "Your session or access has changed. Sign in again to continue.",
        );
        return;
      }
      setNotice(safeError(err), "error");
    }
  }
  async function bootstrap() {
    try {
      const identity = await service.identity();
      if (disposed) return;
      if (!identity) {
        loading = false;
        render();
        return;
      }
      email = identity.email;
      const caps = await service.capabilities();
      if (disposed) return;
      if (!caps.approved) {
        clearAccess(
          "This Google account is not approved. Ask the pack administrator for access, or use another account.",
        );
        return;
      }
      approved = true;
      canRecord = caps.can_record;
      isAdmin = caps.is_admin === true;
      await load(true);
    } catch (err) {
      loading = false;
      error = "We could not check your access. Please try signing in again.";
      render();
    }
  }
  async function finishSave() {
    if (!pending || busy) return;
    const generation = epoch;
    busy = true;
    render();
    const attempt = pending;
    try {
      while (attempt.offset < attempt.entries.length) {
        const chunk = attempt.entries.slice(
          attempt.offset,
          attempt.offset + 25,
        );
        let receipt:void | SaveReceipt;
        if (attempt.family) { if (!service.saveFamily) throw Object.assign(new Error("Family recording is unavailable."),{definitive:true}); receipt=await service.saveFamily(chunk); } else receipt=await service.save(chunk);
        if(receipt)attempt.notificationsQueued+=receipt.notificationsQueued;else attempt.receiptKnown=false;
        if (disposed || !approved || pending !== attempt) return;
        attempt.offset += chunk.length;
      }
      for(const entry of attempt.entries){const c=entry.command;if(c.action==='send_family_message')familyMessageDrafts.delete(String(c.scout_id));if(['review_assignment','cancel_assignment'].includes(String(c.action)))familyReviewDrafts.delete(String(c.assignment_id));if(c.action==='assign_requirement'){assignmentInstructions='';assignmentDue='';}}
      pending = null;
      busy = false;
      attendanceDraft.clear();
      attendanceSelected.clear(); adventureSelected.clear(); adventureRevisions.clear(); priorityDraft = null;
      notice = attempt.label;
      if(attempt.entries.some(e=>e.command.notify_parents===false))notice+=' Saved without sending parent notifications.';
      else if(attempt.entries.some(e=>e.command.notify_parents===true)&&attempt.receiptKnown)notice+=attempt.notificationsQueued?` ${attempt.notificationsQueued} parent notification${attempt.notificationsQueued===1?'':'s'} queued.`:' No parent email was needed.';
      noticeKind = "success";
      if(v2&&attempt.entries.every(({command})=>!['create_activity','mark_family_read'].includes(String(command.action)))){
        homeCompletionNotice=true;
        wizardStep=0;adventureAction='record_requirement';adventureId='';requirementCode='';wizardScoutScope='';correctionReason='';search='';badgeForm='';
        returnHomeAfterScenario(win,'leader',{year,den},notice,true);
        win.scrollTo?.({top:0,behavior:'instant'});
      }
      await load();
    } catch (err) {
      if (disposed || !approved || pending !== attempt || generation !== epoch)
        return;
      busy = false;
      const definitive =
        !!(err as { code?: string; definitive?: boolean })?.code ||
        !!(err as { definitive?: boolean })?.definitive;
      if (definitive) {
        const done = attempt.offset;
        pending = null;
        attendanceDraft.clear();
        attendanceSelected.clear(); adventureSelected.clear(); adventureRevisions.clear(); priorityDraft = null;
        notice = `${done ? `${done} earlier updates were saved. ` : ""}${safeError(err)}`;
        noticeKind = "error";
        await load();
      } else {
        notice =
          "The connection was interrupted before the save could be confirmed.";
        noticeKind = "error";
        render();
      }
    }
  }
  async function commit(commands: Record<string, unknown>[], label: string, family = false) {
    if (!canRecord) throw new Error("Recording access denied");
    if (pending || busy)
      throw new Error("Finish the pending save before making another change.");
    if (!commands.length) {
      setNotice("There are no changes to save.");
      return;
    }
    pending = {
      entries: commands.map((command) => ({
        request_id: win.crypto.randomUUID(),
        command,
      })),
      offset: 0,
      label, family, notificationsQueued:0, receiptKnown:true,
    };
    await finishSave();
  }
  function currentScout(form: HTMLFormElement) {
    const s = scoutById(form.dataset.scout || route().id);
    if (!s) throw new Error("Choose a scout first.");
    return s;
  }
  function equipmentCommand(s: Scout, form: FormData) {
    const action = text(form, "action"),
      e = eligibility(s);
    const command: Record<string, unknown> = {
      action,
      scout_id: s.id,
      scouting_year: year,
      expected_revision: e?.revision || 0,
      occurred_on: text(form, "occurred_on"),
    };
    const note = text(form, "note");
    if (note) command.note = note;
    if (["give_free_item", "issue_loan", "request_purchase"].includes(action))
      command.item = text(form, "item");
    if (
      [
        "give_free_item",
        "issue_loan",
        "request_purchase",
        "return_loan",
        "report_loan_loss",
        "deliver_purchase",
      ].includes(action)
    )
      command.quantity = count(form, "quantity");
    if (text(form, "size")) command.size = text(form, "size");
    if (text(form, "rank_at_issue"))
      command.rank_at_issue = text(form, "rank_at_issue");
    if (text(form, "target_id")) {
      command.target_id = text(form, "target_id");
      const target =
        data.events.find((e) => e.id === command.target_id) ||
        data.loans.find((e) => e.id === command.target_id) ||
        data.losses.find((e) => e.id === command.target_id) ||
        data.purchases.find((e) => e.id === command.target_id);
      if (target) command.scouting_year = target.scouting_year;
    }
    if (text(form, "amount")) {
      command.currency = text(form, "currency").toUpperCase();
      command.amount_minor = toMinor(
        text(form, "amount"),
        String(command.currency),
      );
    }
    return command;
  }
  async function submit(event: Event) {
    const form = event.target as HTMLFormElement;
    if (!form.dataset.form) return;
    event.preventDefault();
    if (!form.reportValidity() || writeDisabled()) return;
    const f = new FormData(form);
    try {
      switch (form.dataset.form) {
        case "den-priorities": {
          const ids = f.getAll("priority_ids").map(String);
          if (ids.length !== 2) throw new Error("Choose exactly two elective adventures.");
          await commit([{action:"set_den_priorities",den:form.dataset.den,scouting_year:year,adventure_ids:ids,expected_revision:Number(form.dataset.revision)}], "Elective priorities saved for the den.");
          break;
        }
        case "inventory": {
          const adding = !form.dataset.item;
          const command: Record<string, unknown> = { action: adding ? "define_inventory_item" : text(f, "action"), item_id: form.dataset.item || win.crypto.randomUUID(), occurred_on: text(f, "occurred_on"), note: text(f, "note") };
          if (text(f, "quantity")) command.quantity = count(f, "quantity");
          if (adding) {
            command.name = text(f, "name"); command.category = text(f, "category");
            if (text(f, "den")) command.den = text(f, "den");
            if (command.quantity !== undefined) command.counted_on = command.occurred_on;
          } else command.expected_revision = Number(form.dataset.revision);
          await commit([command], "Inventory saved.");
          if (!pending && data.inventory.some((i) => i.id === command.item_id)) { addingInventory = false; inventoryItemId = String(command.item_id); render(); }
          break;
        }
        case "activity": {
          const id = win.crypto.randomUUID();
          activityId = id;
          await commit(
            [
              {
                action: "create_activity",
                activity_id: id,
                title: text(f, "title"),
                kind: text(f, "kind"),
                scouting_year: year,
                occurred_on: text(f, "occurred_on"),
              },
            ],
            "Activity created. You can now record attendance.",
          );
          break;
        }
        case "attendance": {
          if (!activityId) throw new Error("Choose an activity.");
          const commands: Record<string, unknown>[] = [];
          if (beta) {
            for (const change of attendanceChanges()) commands.push({action:"record_attendance",activity_id:activityId,scout_id:change.scout.id,status:change.status,expected_revision:change.revision});
            await commit(commands, "Attendance saved."); return;
          }
          for (const field of form.querySelectorAll<HTMLSelectElement>(
            "select[data-attendance]",
          )) {
            if (!field.value) continue;
            const scout = field.dataset.attendance!;
            const current = data.attendance.find(
              (r) => r.activity_id === activityId && r.scout_id === scout,
            );
            if (field.value === current?.status) continue;
            const draft = attendanceDraft.get(`${activityId}:${scout}`);
            commands.push({
              action: "record_attendance",
              activity_id: activityId,
              scout_id: scout,
              status: field.value,
              expected_revision: draft?.revision ?? current?.revision ?? 0,
            });
          }
          await commit(commands, "Attendance saved.");
          break;
        }
        case "family-message": {
          const s=currentScout(form);await commit([{action:'send_family_message',scout_id:s.id,scouting_year:year,as_role:'leader',body:text(f,'body')}],"Message sent to this family.",true);break;
        }
        case "family-review": {
          const s=currentScout(form),decision=text(f,'decision');
          if(decision==='return'&&!text(f,'review_note'))throw new Error('Explain what the parent should revisit.');
          await commit([{action:decision==='cancel'?'cancel_assignment':'review_assignment',scout_id:s.id,scouting_year:year,assignment_id:form.dataset.assignment,expected_revision:Number(form.dataset.revision),review_note:text(f,'review_note'),...(decision==='cancel'?{}:{decision})}],"Parent assignment reviewed.",true);break;
        }
        case "registration": {
          const s = currentScout(form),
            platform = form.dataset.platform!;
          await commit(
            [
              {
                action: "record_registration",
                scout_id: s.id,
                scouting_year: year,
                platform,
                status: text(f, "status"),
                occurred_on: text(f, "occurred_on"),
                expected_revision: registration(s, platform)?.revision || 0,
              },
            ],
            `${platform === "active.com" ? "Active.com" : "Scouting.org"} registration saved.`,
          );
          break;
        }
        case "adventure": {
          const a = data.adventures.find((a) => a.id === adventureId);
          if (!a) throw new Error("Choose an adventure.");
          const ids = f.getAll("scout_ids").map(String);
          if (!ids.length) throw new Error("Select at least one scout.");
          const action = text(f, "adventure_action");
          const notification=f.has("notify_parents")?{notify_parents:text(f,"notify_parents")==="true"}:{};
          if (action === "assign_requirement") {
            const codes=text(f,"requirement_code")==="*"?a.requirements.map(r=>r.code):[text(f,"requirement_code")];
            const commands=ids.flatMap(id=>codes.filter(code=>{const s=scoutById(id);return s&&needsAdventureAction(data,s,a,"assign_requirement",code);}).map(code=>({action,...notification,scout_id:id,scouting_year:year,adventure_id:a.id,requirement_code:code,assigned_on:text(f,"occurred_on"),instructions:text(f,"instructions"),...(text(f,"due_on")?{due_on:text(f,"due_on")}:{})})));
            await commit(commands,"Home assignments saved for the selected families.",true);break;
          }
          if (["record_requirement","undo_requirement"].includes(action) && !a.requirements.some((r) => r.code === text(f,"requirement_code"))) throw new Error("Choose a pending requirement.");
          const commands = ids.filter((id) => { const scout = scoutById(id); return scout && progressEligible(data,scout,a,action,requirementStep(action) ? text(f,"requirement_code") : undefined); }).map((id) => {
            const s = scoutById(id)!;
            const command: Record<string, unknown> = {
              action: action === 'undo_requirement' ? 'record_requirement' : action,
              ...notification,
              scout_id: id,
              adventure_id: a.id,
              scouting_year: year,
              occurred_on: text(f, "occurred_on"),
              expected_revision: adventureRevisions.get(`${a.id}:${id}`) ?? advancement(s, a)?.revision ?? 0,
            };
            if (['revoke_adventure','retract_badge_delivery'].includes(action)) {
              command.reason=text(f,'reason');if(!command.reason)throw new Error('Enter a reason for the correction.');
            }
            if (["record_requirement","undo_requirement"].includes(action)) {
              command.requirement_code = text(f, "requirement_code");
              command.status = action === "undo_requirement" ? "not_completed" : "completed";
            }
            if (action === "deliver_badge")
              command.badge_form = text(f, "badge_form");
            return command;
          });
          await commit(
            commands,
            `Recorded for ${ids.length} scout${ids.length === 1 ? "" : "s"}.`,
          );
          break;
        }
        case "single-adventure": {
          const s = currentScout(form),
            a = data.adventures.find((a) => a.id === form.dataset.adventure);
          if (!a) throw new Error("Choose an adventure.");
          const action = text(f, "action");
          const c: Record<string, unknown> = {
            action,
            ...(f.has("notify_parents")?{notify_parents:text(f,"notify_parents")==="true"}:{}),
            scout_id: s.id,
            adventure_id: a.id,
            scouting_year: year,
            occurred_on: text(f, "occurred_on"),
            expected_revision: advancement(s, a)?.revision || 0,
          };
          if (action === "deliver_badge") c.badge_form = text(f, "badge_form");
          if (["revoke_adventure", "retract_badge_delivery"].includes(action)) {
            c.reason = text(f, "reason");
            if (!c.reason)
              throw new Error("Enter a reason for the correction.");
          }
          await commit([c], "Adventure fieldbook updated.");
          break;
        }
        case "equipment": {
          const s = currentScout(form);
          await commit([equipmentCommand(s, f)], "Equipment record saved.");
          break;
        }
      }
    } catch (err) {
      setNotice(safeError(err), "error");
    }
  }
  async function click(event: Event) {
    const anchor = (event.target as HTMLElement).closest<HTMLAnchorElement>("a[href]");
    if (beta && anchor && anchor.target !== "_blank" && anchor.getAttribute("href") !== win.location.hash && !abandonDraft()) { event.preventDefault(); return; }
    const button = (event.target as HTMLElement).closest<HTMLElement>(
      "[data-action],[data-app-signout]",
    );
    if (!button || button.hasAttribute("disabled")) return;
    const action = button.hasAttribute("data-app-signout")?"logout":button.dataset.action;
    if(action==='assistant-open'&&service.assistant){
      if(!approved||loading||pending||busy||!abandonDraft())return;
      assistantPanel??=createAssistantPanel(doc,service.assistant,()=>({den,year,email}),()=>{void load();},id=>data.photos?.find(p=>p.scout_id===id)?.image);
      await assistantPanel.open();return;
    }
    if (beta && ["logout", "refresh", "home-den", "plan-adventure", "open-activity"].includes(action || "") && !abandonDraft()) return;
    try {
      if(v2 && action?.startsWith('v2-')) {
        if(!abandonDraft())return;
        if(action==='v2-meeting'){win.location.href='/planner?year='+encodeURIComponent(year)+'&den='+encodeURIComponent(den);return;}
        if(action==='v2-families'){familySearch='';search='';win.location.hash='families';render();return;}
        if(action==='v2-gear'){equipmentAction=button.dataset.value||'give_free_item';equipmentTarget='';win.location.hash='equipment';render();return;}
        if(['v2-scout-progress','v2-scout-badges','v2-scout-homework'].includes(action)){
          const scout=scoutById(button.dataset.scout||'');if(!scout)return;den=scout.den||'';search='';wizardScoutScope=scout.id;
          adventureSelected.clear();adventureRevisions.clear();adventureSelected.add(scout.id);
          adventureAction=action==='v2-scout-homework'?'assign_requirement':action==='v2-scout-badges'?'deliver_badge':'record_requirement';adventureId='';requirementCode='';wizardStep=['v2-scout-badges','v2-scout-homework'].includes(action)?1:0;
        }else{
          wizardScoutScope='';
          adventureSelected.clear();adventureRevisions.clear();search='';
          adventureId=button.dataset.id||'';requirementCode=button.dataset.code||'';
          adventureAction=['v2-handout','v2-badge-handout'].includes(action)?'deliver_badge':'record_requirement';
          wizardStep=action==='v2-badge-requirement'?3:action==='v2-badge-record'?2:action==='v2-handout'?1:action==='v2-badge-handout'?3:0;
        }
        progressClassic=false;win.location.hash='adventures';render();return;
      }
      if(action==='progress-classic'||action==='progress-guided') {
        if(writeDisabled()||!abandonDraft())return;
        progressClassic=action==='progress-classic';win.localStorage.setItem(v2?'pack99-v2-progress-view':'pack99-progress-view',progressClassic?'classic':'guided');
        adventureSelected.clear();adventureRevisions.clear();wizardStep=0;adventureAction='record_requirement';render();return;
      }
      if(action?.startsWith('wizard-')) {
        if(writeDisabled())return;
        if(action==='wizard-all') {const a=data.adventures.find(a=>a.id===adventureId);if(a)for(const s of adventureRoster())if(progressEligible(data,s,a,adventureAction,requirementStep(adventureAction)?requirementCode:undefined))adventureSelected.add(s.id);}
        else if(action==='wizard-back'||action==='wizard-goto') {wizardStep=action==='wizard-goto'?Number(button.dataset.value):wizardStep===3&&!requirementStep(adventureAction)?1:Math.max(0,wizardStep-1);}
        else if(action==='wizard-cancel') {adventureSelected.clear();adventureRevisions.clear();wizardStep=0;assignmentInstructions='';assignmentDue='';correctionReason='';}
        else {
          adventureSelected.clear();adventureRevisions.clear();
          if(action==='wizard-action'){adventureAction=button.dataset.value!;adventureId='';requirementCode='';wizardStep=1;correctionReason='';}
          if(action==='wizard-adventure'){adventureId=button.dataset.value!;requirementCode='';wizardStep=requirementStep(adventureAction)?2:3;}
          if(action==='wizard-requirement'){requirementCode=button.dataset.value!;wizardStep=3;}
        }
        render();if(!['wizard-all'].includes(action))root.querySelector<HTMLElement>('#progress-question')?.focus();return;
      }
      if (action === "home-den") {
        den = button.dataset.den || ""; adventureId = ""; badgeForm = ""; wizardStep=0;
        adventureSelected.clear(); adventureRevisions.clear(); attendanceSelected.clear(); priorityDraft = null; wizardStep=0;
        syncAttendanceSelection();
        render(); return;
      }
      if(action==='family-open'){
        const roster=v2?activeScouts().filter(s=>!den||s.den===den):filtered();
        if(roster.some(s=>s.id===button.dataset.scout)){
          if(v2){win.location.hash='families/'+encodeURIComponent(button.dataset.scout!);render();win.scrollTo?.({top:0,behavior:'instant'});const title=root.querySelector<HTMLElement>('main h1');title?.setAttribute('tabindex','-1');title?.focus({preventScroll:true});}
          else{familyScoutId=button.dataset.scout!;render();}
        }return;
      }
      if(action==='family-mark-read'){
        await commit([{action:'mark_family_read',scout_id:button.dataset.scout,scouting_year:year,through_message_id:button.dataset.message}],"Conversation marked read.",true);return;
      }
      if (action === "plan-adventure") {
        const a = data.adventures.find((a) => a.id === button.dataset.id); if (!a) return;
        if (beta && !den) den = activeScouts().find((s) => denRank(s.den) === a.rank)?.den || "";
        search = ""; adventureId = a.id; adventureSelected.clear(); adventureRevisions.clear();
        const roster = activeScouts().filter((s) => (!den || s.den === den) && denRank(s.den) === a.rank && needsAdventureAction(data,s,a,"earn_adventure"));
        for (const s of roster) adventureSelected.add(s.id);
        adventureAction = roster.some((s) => needsAdventureAction(data,s,a,"record_requirement")) ? "record_requirement" : "earn_adventure";
        requirementCode = [...a.requirements].sort((x,y) => roster.filter((s) => needsAdventureAction(data,s,a,"record_requirement",y.code)).length - roster.filter((s) => needsAdventureAction(data,s,a,"record_requirement",x.code)).length)[0]?.code || "";
        if(!progressClassic){adventureSelected.clear();wizardStep=2;}
        win.location.hash = "adventures"; render(); return;
      }
      if (["attendance-select-all","attendance-clear","adventure-select-all","adventure-clear"].includes(action || "")) {
        if (writeDisabled()) return;
        if (beta && action!.startsWith("attendance")) {
          for (const s of filtered()) selectAttendance(s.id, action === "attendance-select-all");
          render(); return;
        }
        const set = action!.startsWith("attendance") ? attendanceSelected : adventureSelected;
        set.clear(); if (action!.endsWith("select-all")) for (const s of filtered()) set.add(s.id);
        render(); return;
      }
      if (action === "apply-attendance") {
        if (writeDisabled()) return;
        for (const s of filtered().filter((s) => attendanceSelected.has(s.id))) {
          const key = `${activityId}:${s.id}`;
          attendanceDraft.set(key,{status:attendanceBulkStatus,revision:attendanceDraft.get(key)?.revision ?? data.attendance.find((r) => r.activity_id === activityId && r.scout_id === s.id)?.revision ?? 0});
        }
        render(); return;
      }
      if (action === "open-inventory-item") { inventoryItemId = button.dataset.id || ""; addingInventory = false; inventoryAction = "inventory_count"; render(); return; }
      if (action === "new-inventory") { addingInventory = true; inventoryItemId = ""; render(); return; }
      if (action === "close-inventory") { addingInventory = false; inventoryItemId = ""; render(); return; }
      if (action === "copy-mcp-url") {
        const input = root.querySelector<HTMLInputElement>("#mcp-server-url");
        const status = root.querySelector<HTMLElement>("#mcp-copy-status");
        if (!input || !status) return;
        button.setAttribute("disabled", "");
        status.textContent = "";
        try {
          await win.navigator.clipboard.writeText(mcpServerUrl);
          button.textContent = "Copied!";
          status.textContent = "MCP URL copied. Paste it into Claude’s connector URL field.";
        } catch {
          input.focus();
          input.select();
          button.textContent = "Copy URL";
          status.textContent = "Your browser blocked automatic copying. The URL is selected; choose Copy to copy it manually.";
        } finally {
          button.removeAttribute("disabled");
        }
        return;
      }
      if (action === "login") {
        loading = true;
        render();
        try {
          await service.signIn();
        } catch {
          loading = false;
          error = "Google sign-in could not start. Please try again.";
          render();
        }
        return;
      }
      if (action === "logout") {
        await service.signOut();
        clearAccess();
        email = "";
        render();
        return;
      }
      if (action === "dismiss") {
        homeCompletionNotice=false;
        notice = "";
        render();
        return;
      }
      if (action === "refresh") {
        adventureSelected.clear(); adventureRevisions.clear(); attendanceSelected.clear(); priorityDraft = null; wizardStep=0;
        attendanceDraft.clear();
        await load();
        return;
      }
      if (action === "retry") {
        await finishSave();
        return;
      }
      if (action === "open-activity") {
        activityId = button.dataset.id!;
        syncAttendanceSelection();
        win.location.hash = "attendance";
        render();
        return;
      }
      if (action === "profile-tab") {
        profileTab = button.dataset.tab!;const r=route();win.history.replaceState(null,'','#scout/'+r.id+'/'+profileTab);
        render();
        if(profileTab==='family')void refreshFamilyInbox();
        return;
      }
      if (
        ["open-equipment", "open-registration", "open-adventures"].includes(
          action || "",
        )
      ) {
        profileTab =
          action === "open-equipment"
            ? "equipment"
            : action === "open-registration"
              ? "registration"
              : "adventures";
        equipmentAction = "give_free_item";
        equipmentTarget = "";
        win.location.hash = `scout/${button.dataset.scout}`;
        render();
        return;
      }
      if (action === "all-present" && canRecord && !writeDisabled()) {
        for (const s of filtered()) {
          const key = `${activityId}:${s.id}`;
          attendanceDraft.set(key, {
            status: "present",
            revision:
              attendanceDraft.get(key)?.revision ??
              data.attendance.find(
                (r) => r.activity_id === activityId && r.scout_id === s.id,
              )?.revision ??
              0,
          });
        }
        render();
        return;
      }
      if (action === "requirement") {
        if (writeDisabled()) return;
        const s = scoutById(button.dataset.scout!),
          a = data.adventures.find((a) => a.id === button.dataset.adventure);
        if (!s || !a) return;
        if(v2&&button.dataset.status==='completed'){
          if(!abandonDraft())return;
          den=s.den||'';search='';wizardScoutScope=s.id;adventureId=a.id;requirementCode=button.dataset.code||'';
          adventureAction='record_requirement';wizardStep=3;progressClassic=false;adventureSelected.clear();adventureRevisions.clear();adventureSelected.add(s.id);
          win.location.hash='adventures';render();return;
        }
        if (
          button.dataset.status === "not_completed" &&
          !win.confirm(
            "Mark this requirement as not completed? The original completion stays in history.",
          )
        )
          return;
        await commit(
          [
            {
              action: "record_requirement",
              scout_id: s.id,
              adventure_id: a.id,
              scouting_year: year,
              requirement_code: button.dataset.code,
              status: button.dataset.status,
              occurred_on: selectedDate,
              expected_revision: advancement(s, a)?.revision || 0,
            },
          ],
          "Requirement updated.",
        );
      }
    } catch (err) {
      setNotice(safeError(err), "error");
    }
  }
  function change(event: Event) {
    const target = event.target as HTMLInputElement | HTMLSelectElement;
    const id = target.id;
    if (beta && ["den-filter","year-filter","activity-select"].includes(id) && !abandonDraft()) { render(); return; }
    if (id === "den-filter") {
      den = target.value;
      badgeForm = "";
      adventureSelected.clear(); adventureRevisions.clear(); attendanceSelected.clear(); priorityDraft = null; wizardStep=0;
      adventureId = "";
      syncAttendanceSelection();
      render();
    } else if (id === "year-filter") {
      if (busy || pending) {
        render();
        return;
      }
      if (!validYear(target.value)) {
        target.setCustomValidity("Use consecutive years, for example 2026-27.");
        target.reportValidity();
        return;
      }
      target.setCustomValidity("");
      year = target.value;
      adventureSelected.clear(); adventureRevisions.clear(); attendanceSelected.clear(); priorityDraft = null; wizardStep=0;
      activityId = "";
      adventureId = "";
      attendanceDraft.clear();
      void load();
    } else if (id === "activity-select") {
      activityId = target.value;
      attendanceSelected.clear(); attendanceBulkStatus = "present";
      syncAttendanceSelection();
      render();
    } else if (id === "family-scout") { familyScoutId=target.value;render();
    } else if (id === "inventory-category") {
      inventoryCategory = target.value; render();
    } else if (id === "inventory-action") {
      inventoryAction = target.value; render();
    } else if (id === "adventure-select") {
      rememberAdventureSelection();
      adventureId = target.value;
      render();
    } else if (id === "equipment-action") {
      equipmentAction = target.value;
      equipmentTarget = "";
      render();
    } else if (id === "equipment-target") {
      equipmentTarget = target.value;
      render();
    } else if (id === "equipment-scout" && target.value) {
      profileTab = "equipment";
      win.location.hash = `scout/${target.value}`;
      render();
    } else if (id === "adventure-action") {
      rememberAdventureSelection(); adventureAction = target.value;if(adventureAction === "assign_requirement")selectedDate=todayLA(); render();
    } else if (id === "attendance-bulk-status") {
      attendanceBulkStatus = target.value;
      if (beta) { for (const scoutId of attendanceSelected) selectAttendance(scoutId, true); render(); }
    } else if (target.name === "attendance_scout_ids") {
      if (beta) selectAttendance(target.value, (target as HTMLInputElement).checked);
      else if ((target as HTMLInputElement).checked) attendanceSelected.add(target.value); else attendanceSelected.delete(target.value);
      render();
    } else if (target.name === "reason") {
      correctionReason=target.value;
    } else if (target.name === "scout_ids") {
      rememberAdventureSelection(); render();
    } else if (target.name === "requirement_code") {
      requirementCode = target.value; render();
    } else if (target.name === "priority_ids") {
      if (!priorityDraft) priorityDraft = new Set();
      if ((target as HTMLInputElement).checked) {
        if (priorityDraft.size >= 2) { (target as HTMLInputElement).checked = false; setNotice("Choose two priorities. Unselect one before adding another.","error"); return; }
        priorityDraft.add(target.value);
      } else priorityDraft.delete(target.value);
      render();
    } else if (target.name === "instructions") { assignmentInstructions=target.value;
    } else if (target.name === "due_on") { assignmentDue=target.value;
    } else if(target.name==='decision'){const form=target.closest<HTMLFormElement>('form[data-form="family-review"]');if(form)familyReviewDrafts.set(form.dataset.assignment!,{note:(form.querySelector('[name="review_note"]')as HTMLTextAreaElement).value,decision:target.value});
    } else if (target.name === "badge_form") {
      badgeForm = target.value;
    } else if (target.name === "occurred_on") {
      selectedDate = target.value;
    } else if (id === "quick-date") {
      selectedDate = target.value;
    } else if (target.hasAttribute("data-select-all")) {
      for (const checkbox of root.querySelectorAll<HTMLInputElement>(
        'input[name="scout_ids"]',
      ))
        checkbox.checked = (target as HTMLInputElement).checked;
    } else if (target.dataset.attendance) {
      const key = `${activityId}:${target.dataset.attendance}`;
      attendanceDraft.set(key, {
        status: target.value,
        revision:
          attendanceDraft.get(key)?.revision ??
          data.attendance.find(
            (r) =>
              r.activity_id === activityId &&
              r.scout_id === target.dataset.attendance,
          )?.revision ??
          0,
      });
      render();
    }
  }
  function input(event: Event) {
    const field = event.target as HTMLInputElement;
    const form=field.closest<HTMLFormElement>('form');
    if(form?.dataset.form==='family-message'&&field.name==='body'){if(field.value.trim())familyMessageDrafts.set(form.dataset.scout!,field.value);else familyMessageDrafts.delete(form.dataset.scout!);return;}
    if(form?.dataset.form==='family-review'&&field.name==='review_note'){familyReviewDrafts.set(form.dataset.assignment!,{note:field.value,decision:(form.querySelector('[name="decision"]')as HTMLSelectElement).value});return;}
    if(field.name==='reason'){correctionReason=field.value;return;}
    if(field.name==='instructions'){assignmentInstructions=field.value;return;}
    if(field.name==='due_on'){assignmentDue=field.value;return;}
    if(v2&&field.id==='family-work-search'){familySearch=field.value;render();return;}
    if (v2 && field.id === 'v2-badge-search') {badgeSearch=field.value;render();return;}
    if (field.id === "global-search") {
      if (route().view === "inventory") { inventorySearch = field.value; render(); return; }
      search = field.value;
      if (search && !["scouts","attendance","adventures","families"].includes(route().view)) win.location.hash = "scouts";
      render();
    }
  }
  let checkingFamily=false;
  async function refreshFamilyInbox(){
    const view=route().view;
    if(!service.loadFamily||checkingFamily||!approved||loading||busy||pending||hasDraft()||disposed||doc.visibilityState==='hidden'||!['families','home','overview','more'].includes(view)&&!(view==='profile'&&profileTab==='family'))return;
    const token=epoch;checkingFamily=true;
    try{const fresh=await service.loadFamily(year);if(disposed||token!==epoch||busy||pending||hasDraft())return;if(JSON.stringify(fresh.assignments)!==JSON.stringify(data.assignments)||JSON.stringify(fresh.familyMessages)!==JSON.stringify(data.familyMessages))await load();}catch{/* Explicit refresh reports connection errors; background polling keeps the current view. */}finally{checkingFamily=false;}
  }
  const hashChange = (event?:HashChangeEvent) => {
    // Ignore an older queued navigation event after a successful save replaces the route with Home.
    if(event?.newURL&&new URL(event.newURL).hash!==win.location.hash)return;
    const home=route().view==='home';
    if(!home||!homeCompletionNotice)notice='';
    if(!home)homeCompletionNotice=false;
    render();
    void refreshFamilyInbox();
  };
  const familyTimer=service.loadFamily?win.setInterval(()=>{void refreshFamilyInbox();},30000):null;
  const beforeUnload = (event: BeforeUnloadEvent) => {
    if (pending || (beta && hasDraft())) {
      event.preventDefault();
      event.returnValue = "";
    }
  };
  root.addEventListener("submit", submit);
  root.addEventListener("click", click);
  root.addEventListener("change", change);
  root.addEventListener("input", input);
  win.addEventListener("hashchange", hashChange);
  win.addEventListener("focus", refreshAccess);
  win.addEventListener("beforeunload", beforeUnload);
  const unsubscribe = service.onSignOut?.(() => {
    email = "";
    clearAccess();
  });
  render();
  const ready = bootstrap();
  return {
    ready,
    dispose() {
      assistantPanel?.dispose();
      disposed = true;
      removeReview();
      if(familyTimer!==null)win.clearInterval(familyTimer);
      epoch++;
      data = emptyData();
    familyMessageDrafts.clear();familyReviewDrafts.clear();assignmentInstructions="";assignmentDue="";
      root.replaceChildren();
      unsubscribe?.();
      root.removeEventListener("submit", submit);
      root.removeEventListener("click", click);
      root.removeEventListener("change", change);
      root.removeEventListener("input", input);
      win.removeEventListener("hashchange", hashChange);
      win.removeEventListener("focus", refreshAccess);
      win.removeEventListener("beforeunload", beforeUnload);
    },
  };
}
