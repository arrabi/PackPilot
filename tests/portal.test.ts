import { test } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import {
  mountPortal,
  type PortalService,
  type Entry,
} from "../auth-ui/portal-ui.ts";
import {
  emptyData,
  collectPages,
  toMinor,
  todayLA,
  escapeHtml,
  safeSource,
  preferredDen,
  type PortalData,
} from "../auth-ui/portal-model.ts";
import { m2Fixture, id } from "./helpers/m2.ts";
const scout = id("1", 1),
  second = id("1", 2),
  activity = id("2", 1),
  adventure = id("4", 1),
  purchase = id("3", 80);
function fixture(): PortalData {
  return {
    ...emptyData(),
    scouts: [
      { id: scout, scout_name: "First Synthetic", den: "0-Lions" },
      { id: second, scout_name: "Second Synthetic", den: "0-Lions" },
    ],
    activities: [
      {
        id: activity,
        title: "Synthetic meeting",
        kind: "session",
        occurred_on: "2026-10-01",
        scouting_year: "2026-27",
      },
    ],
    adventures: [
      {
        id: adventure,
        name: "Synthetic adventure",
        rank: "lion",
        program_version: "test",
        source_url: "https://www.scouting.org/test/",
        requirements: [
          { code: "1", description: "First task" },
          { code: "2", description: "Second task" },
        ],
        readiness_mode: "automatic",
      },
    ],
    advancement: [
      {
        scout_id: scout,
        adventure_id: adventure,
        revision: 2,
        earned_on: null,
        badge_delivered_on: null,
        badge_form: null,
      },
    ],
    eligibility: [
      { scout_id: scout, revision: 7, free_shirt_eligibility: "unknown" },
      { scout_id: second, revision: 0, free_shirt_eligibility: "unknown" },
    ],
    purchases: [
      {
        id: purchase,
        scout_id: scout,
        revision: 6,
        action: "request_purchase",
        scouting_year: "2026-27",
        occurred_on: "2026-10-01",
        item: "tshirt",
        quantity: 2,
        price_minor: 2000,
        price_currency: "USD",
        balance_minor: 2000,
        unfulfilled_quantity: 2,
      },
    ],
    registrations: [
      {
        scout_id: scout,
        platform: "scouting.org",
        status: "unknown",
        revision: 3,
        occurred_on: "2026-10-01",
      },
    ],
    summary: [scout, second].map((scout_id) => ({
      scout_id,
      active_registration: "unknown",
      scouting_registration: "unknown",
      earned_adventures: 0,
      badges_to_deliver: 0,
      outstanding_loan_items: 0,
      unpaid_loss_charges: 0,
      unfulfilled_purchase_requests: 0,
    })),
  };
}
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
function fixtureWithWithdrawals(): PortalData {
  const data = fixture();
  for (const [n, den] of [[3, "(withdraw) 3-Bears"], [4, "  (WITHDRAW) 5-AOL"]] as const) {
    const scout_id = id("1", n);
    data.scouts.push({ id: scout_id, scout_name: `Withdrawn Synthetic ${n}`, den });
    data.summary.push({ ...data.summary[0], scout_id, earned_adventures: 99, badges_to_deliver: 99 });
    data.advancement.push({ ...data.advancement[0], scout_id, earned_on: "2026-10-01" });
    data.attendance.push({ scout_id, activity_id: activity, status: "present", revision: 1, occurred_on: "2026-10-01" });
    data.loans.push({ id: id("3", n), scout_id, revision: 1, action: "loan_item", scouting_year: "2026-27", occurred_on: "2026-10-01", item: "slider", quantity: 1, outstanding_quantity: 1 });
  }
  // A missing den means unknown, rather than withdrawn.
  data.scouts[1].den = null;
  return data;
}

test("touch attendance multi-selection applies Attending only to selected scouts", async () => {
 const app=await setup("attendance");
 try {
  app.set("#activity-select",activity);
  app.click(`label.scout-choice:has(input[value="${scout}"])`);
  assert.equal((app.root.querySelector(`input[name="attendance_scout_ids"][value="${scout}"]`) as unknown as {checked:boolean}).checked,true);
  app.click('[data-action="apply-attendance"]');
  await app.submit('[data-form="attendance"]');
  assert.equal(app.saved[0].length,1);assert.equal(app.saved[0][0].command.scout_id,scout);assert.equal(app.saved[0][0].command.status,"present");
 } finally {app.close();}
});

test("completion choices omit completed requirements and skip already completed scouts without replacing their dates", async () => {
 const data=fixture();
 data.progress=[{scout_id:scout,adventure_id:adventure,requirement_code:"1",completed_on:"2026-10-01",completion_source:"individual"}];
 const app=await setup("adventures",{},data);
 try {
  app.click(`label.scout-choice:has(input[value="${scout}"])`);
  assert.deepEqual([...app.root.querySelectorAll('[name="requirement_code"] option')].map((o)=>(o as unknown as {value:string}).value),["2"]);
  app.click(`label.scout-choice:has(input[value="${second}"])`);
  app.set('[name="requirement_code"]',"1");
  await app.submit('[data-form="adventure"]');
  assert.equal(app.saved[0].length,1);assert.equal(app.saved[0][0].command.scout_id,second);
  assert.equal(app.saved[0][0].command.requirement_code,"1");
  assert.equal(data.progress[0].completed_on,"2026-10-01");
 } finally {app.close();}
});

test("den home transitions to two elective priorities only after all required adventures are earned", async () => {
 const data=fixture();
 data.adventures[0].catalog_context={adventure_type:"Required (Core)"};
 data.adventures.push(...[2,3,4].map((n)=>({...data.adventures[0],id:id("4",n),name:`Elective ${n}`,catalog_context:{adventure_type:"Elective"}})));
 data.advancement = [];
 for(const scout_id of [scout,second]) data.advancement.push({scout_id,adventure_id:adventure,revision:1,earned_on:"2026-10-01",badge_delivered_on:null,badge_form:null});
 const app=await setup("next",{},data);
 try {
  assert.match(app.root.textContent!,/Choose 2 elective adventures to prioritize/);
  app.click(`label.scout-choice:has(input[value="${id("4",2)}"])`);
  app.click(`label.scout-choice:has(input[value="${id("4",3)}"])`);
  app.click(`label.scout-choice:has(input[value="${id("4",4)}"])`);
  assert.equal(app.root.querySelectorAll('[name="priority_ids"]:checked').length,2);
  await app.submit('[data-form="den-priorities"]');
  assert.equal(app.saved[0][0].command.action,"set_den_priorities");
  assert.deepEqual(app.saved[0][0].command.adventure_ids,[id("4",2),id("4",3)]);
  assert.equal(app.saved[0][0].command.den,"0-Lions");
 } finally {app.close();}
});

test("completed shared electives give way to another pair using the current plan revision", async () => {
 const data=fixture();
 data.adventures[0].catalog_context={adventure_type:"Required (Core)"};
 data.adventures.push(...[2,3,4,5].map((n)=>({...data.adventures[0],id:id("4",n),name:`Elective ${n}`,catalog_context:{adventure_type:"Elective"}})));
 data.advancement=[];
 for(const scout_id of [scout,second]) for(const n of [1,2,3]) data.advancement.push({scout_id,adventure_id:id("4",n),revision:1,earned_on:"2026-10-14",badge_delivered_on:null,badge_form:null});
 data.denPlans=[{den:"0-Lions",scouting_year:"2026-27",adventure_ids:[id("4",2),id("4",3)],revision:4}];
 const app=await setup("next",{},data);
 try {
  assert.match(app.root.textContent!,/Both shared elective priorities are complete/);
  assert.match(app.root.textContent!,/Choose another 2 elective adventures/);
  assert.deepEqual([...app.root.querySelectorAll('[name="priority_ids"]')].map((i)=>(i as unknown as {value:string}).value),[id("4",4),id("4",5)]);
  app.click(`label.scout-choice:has(input[value="${id("4",4)}"])`);
  app.click(`label.scout-choice:has(input[value="${id("4",5)}"])`);
  await app.submit('[data-form="den-priorities"]');
  assert.equal(app.saved[0][0].command.expected_revision,4);
  assert.deepEqual(app.saved[0][0].command.adventure_ids,[id("4",4),id("4",5)]);
  assert.equal(data.advancement.length,6);
 } finally {app.close();}
});

test("inventory shows stock separately, honors den filters and records counted totals including zero", async () => {
  const data = fixture();
  const stock = id("7",1);
  data.inventory = [
    { id:stock,name:'Synthetic neckerchief <img src=x onerror="alert(1)">',den:"0-Lions",category:"neckerchief",quantity_on_hand:6,revision:7,last_counted_on:"2026-10-14",last_recorded_on:"2026-10-14",source_context:{} },
    { id:id("7",2),name:"Unknown books",den:"0-Lions",category:"book",quantity_on_hand:null,revision:1,last_counted_on:null,last_recorded_on:"2026-10-14",source_context:{} },
    { id:id("7",3),name:"Pack-wide patch",den:null,category:"other",quantity_on_hand:0,revision:1,last_counted_on:"2026-10-14",last_recorded_on:"2026-10-14",source_context:{} },
    { id:id("7",4),name:"Tiger stock",den:"1-Tigers",category:"slider",quantity_on_hand:9,revision:1,last_counted_on:null,last_recorded_on:"2026-10-14",source_context:{} },
  ];
  const app=await setup("inventory",{capabilities:async()=>({approved:true,can_record:true,default_den:"Lion"})},data);
  try {
    assert.match(app.root.textContent!,/Unknown books/);assert.match(app.root.textContent!,/Pack-wide patch/);
    assert.doesNotMatch(app.root.textContent!,/Tiger stock/);
    assert.equal(app.root.querySelector("#workspace img"),null);
    app.click(`[data-action="open-inventory-item"][data-id="${stock}"]`);
    app.set('[data-form="inventory"] [name="quantity"]',"0");
    app.set('[data-form="inventory"] [name="note"]',"Physical count found no stock");
    app.set('[data-form="inventory"] [name="occurred_on"]',"2026-10-14");
    await app.submit('[data-form="inventory"]');
    assert.deepEqual(app.saved[0][0].command,{action:"inventory_count",item_id:stock,quantity:0,expected_revision:7,note:"Physical count found no stock",occurred_on:"2026-10-14"});
  } finally { app.close(); }
  const reader=await setup("inventory",{capabilities:async()=>({approved:true,can_record:false})},data);
  try {
    reader.click(`[data-action="open-inventory-item"][data-id="${stock}"]`);
    assert.equal((reader.root.querySelector('[data-form="inventory"] fieldset') as unknown as {disabled:boolean}).disabled,true);
    assert.equal(reader.saved.length,0);
  } finally { reader.close(); }
});

test("leader default den resolves supported names and applies once at login", async () => {
  const dens = ["0-Lions", "1-Tigers", "2-Wolves", "3-Bears", "4-Webelos", "5-AOL"];
  const scouts = dens.map((den, i) => ({ id: id("1", i + 1), scout_name: "Synthetic", den }));
  for (const [name, den] of [["Lion", dens[0]], ["lions", dens[0]], [" Tiger ", dens[1]], ["Wolf", dens[2]], ["Wolves", dens[2]], ["Bear", dens[3]], ["Webelos", dens[4]], ["AOL", dens[5]], ["Arrow of Light", dens[5]], ["5-AOL", dens[5]]])
    assert.equal(preferredDen(name, scouts), den);
  for (const name of [null, undefined, "", "  ", "invalid"])
    assert.equal(preferredDen(name, scouts), "");
  assert.equal(preferredDen("Bear", [{ id: scout, scout_name: "Withdrawn", den: "(withdraw) 3-Bears" }]), "");
  assert.equal(preferredDen("Lion", [...scouts, { id: second, scout_name: "Another", den: "Lions" }]), "");

  const data = fixture(); data.scouts[1].den = "1-Tigers";
  const app = await setup("scouts", { capabilities: async () => ({ approved: true, can_record: false, default_den: "Tiger" }) }, data);
  try {
    const selected = () => (app.root.querySelector("#den-filter") as unknown as { value: string }).value;
    assert.equal(selected(), "1-Tigers");
    assert.match(app.root.textContent!, /Second Synthetic/);
    assert.doesNotMatch(app.root.textContent!, /First Synthetic/);
    app.set("#den-filter", "0-Lions");
    app.click('[data-action="refresh"]');
    await flush(); await flush();
    assert.equal(selected(), "0-Lions");
    app.set("#den-filter", "");
    app.click('[data-action="refresh"]');
    await flush(); await flush();
    assert.equal(selected(), "");
    assert.match(app.root.textContent!, /First Synthetic/);
    assert.match(app.root.textContent!, /Second Synthetic/);
  } finally { app.close(); }
});

test("withdrawn scouts stay out of every portal tab, totals and den choices", async () => {
  for (const tab of ["overview", "scouts", "adventures", "equipment", "followups"]) {
    const data = fixtureWithWithdrawals();
    const app = await setup(tab, {}, data);
    try {
      assert.doesNotMatch(app.root.textContent!, /Withdrawn Synthetic|\(withdraw\)/i, tab);
      const choices = [...app.root.querySelectorAll("#den-filter option")].map((o) => o.textContent);
      assert.deepEqual(choices, ["All dens", "Lions"]);
      if (tab === "overview")
        assert.deepEqual([...app.root.querySelectorAll(".stat strong")].map((e) => e.textContent), ["2", "0", "0", "2"]);
      if (tab === "scouts" || tab === "adventures") {
        assert.match(app.root.textContent!, /First Synthetic/);
      }
      if (tab === "scouts") assert.match(app.root.textContent!, /Second Synthetic/);
      // Rendering must preserve the source roster and historical operations.
      assert.equal(data.scouts.length, 4);
      assert.equal(data.attendance.length, 2);
      assert.equal(app.saved.length, 0);
    } finally { app.close(); }
  }
});

test("withdrawn scouts are excluded from attendance totals and bulk saves", async () => {
  const app = await setup("attendance", {}, fixtureWithWithdrawals());
  try {
    app.set("#activity-select", activity);
    assert.doesNotMatch(app.root.textContent!, /Withdrawn Synthetic/);
    assert.match(app.root.textContent!, /0 present in the pack/);
    app.click('[data-action="all-present"]');
    await app.submit('[data-form="attendance"]');
    assert.deepEqual(app.saved.flat().map((e) => e.command.scout_id).sort(), [scout, second].sort());
  } finally { app.close(); }
});

test("old profile links cannot reopen a withdrawn scout in the portal", async () => {
  const app = await setup(`scout/${id("1", 3)}`, {}, fixtureWithWithdrawals());
  try {
    assert.match(app.root.textContent!, /Scout not found/);
    assert.doesNotMatch(app.root.textContent!, /Withdrawn Synthetic/);
  } finally { app.close(); }
});

async function setup(
  hash = "overview",
  overrides: Partial<PortalService> = {},
  data = fixture(),
  beta = false,
  guided = false,
) {
  const window = new Window({ url: "https://pack99.example.invalid/prev/#" + hash });
  if(!guided) window.localStorage.setItem('pack99-progress-view','classic');
  const oldFormData = globalThis.FormData;
  globalThis.FormData = window.FormData as unknown as typeof FormData;
  window.document.body.innerHTML = '<div id="app"></div>';
  const root = window.document.getElementById("app")!;
  const saved: Entry[][] = [];
  let loads = 0;
  let signedOut = () => {};
  const service: PortalService = {
    identity: async () => ({ email: "leader@example.invalid" }),
    capabilities: async () => ({ approved: true, can_record: true }),
    load: async () => {
      loads++;
      return structuredClone(data);
    },
    saveFamily: async (entries) => {saved.push(structuredClone(entries));},
    save: async (entries) => {
      saved.push(structuredClone(entries));
    },
    signIn: async () => {},
    signOut: async () => {
      signedOut();
    },
    onSignOut: (callback) => {
      signedOut = callback;
      return () => {};
    },
    ...overrides,
  };
  const portal = mountPortal(root as unknown as HTMLElement, service, { beta });
  await portal.ready;
  const click = (selector: string) => {
    const element = root.querySelector(selector);
    assert.ok(element, "Missing " + selector);
    (element as unknown as { click(): void }).click();
  };
  const set = (selector: string, value: string) => {
    const element = root.querySelector(selector) as unknown as {
      value: string;
      dispatchEvent(e: unknown): void;
    };
    assert.ok(element, "Missing " + selector);
    element.value = value;
    element.dispatchEvent(new window.Event("change", { bubbles: true }));
  };
  const submit = async (selector: string) => {
    const form = root.querySelector(selector)!;
    assert.ok(form, "Missing " + selector);
    form.dispatchEvent(
      new window.Event("submit", { bubbles: true, cancelable: true }),
    );
    await flush();
    await flush();
  };
  return {
    window,
    root,
    saved,
    loads: () => loads,
    click,
    set,
    submit,
    signedOut: () => signedOut(),
    close() {
      portal.dispose();
      globalThis.FormData = oldFormData;
      window.happyDOM.abort();
    },
  };
}

test("portal does not fetch or render scout data before approval and disables writes for readers", async () => {
  let loads = 0;
  for (const identity of [null, { email: "unapproved@example.invalid" }]) {
    const app = await setup("scouts", {
      identity: async () => identity,
      capabilities: async () => ({ approved: false, can_record: false }),
      load: async () => {
        loads++;
        return fixture();
      },
    });
    try {
      assert.equal(loads, 0);
      assert.doesNotMatch(app.root.textContent!, /First Synthetic/);
      assert.match(app.root.textContent!, /Continue with Google/);
    } finally {
      app.close();
    }
  }
  const app = await setup("attendance", {
    capabilities: async () => ({ approved: true, can_record: false }),
  });
  try {
    assert.equal(
      (app.root.querySelector("fieldset") as unknown as { disabled: boolean })
        .disabled,
      true,
    );
    assert.match(app.root.textContent!, /read-only access/i);
    assert.equal(app.saved.length, 0);
  } finally {
    app.close();
  }
});

test("attendance saves only explicit changes with dated activity and current revisions", async () => {
  const app = await setup("attendance");
  try {
    app.set("#activity-select", activity);
    app.set(`[data-attendance="${scout}"]`, "present");
    await app.submit('[data-form="attendance"]');
    assert.equal(app.saved.length, 1);
    assert.equal(app.saved[0].length, 1);
    assert.deepEqual(app.saved[0][0].command, {
      action: "record_attendance",
      activity_id: activity,
      scout_id: scout,
      status: "present",
      expected_revision: 0,
    });
    assert.ok(app.saved[0][0].request_id);
    assert.equal("recorded_by" in app.saved[0][0].command, false);
  } finally {
    app.close();
  }
});

test("interrupted saves retry the identical request ID and block unrelated new writes", async () => {
  const calls: Entry[][] = [];
  let first = true;
  const app = await setup("attendance", {
    save: async (entries) => {
      calls.push(structuredClone(entries));
      if (first) {
        first = false;
        throw new Error("Network request failed");
      }
    },
  });
  try {
    app.set("#activity-select", activity);
    app.set(`[data-attendance="${scout}"]`, "present");
    await app.submit('[data-form="attendance"]');
    assert.match(app.root.textContent!, /save was not confirmed/i);
    assert.equal(
      (
        app.root.querySelector("#year-filter") as unknown as {
          disabled: boolean;
        }
      ).disabled,
      true,
    );
    app.click('[data-action="retry"]');
    await flush();
    await flush();
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1], calls[0]);
    assert.match(app.root.textContent!, /Attendance saved/);
  } finally {
    app.close();
  }
});

test("a stale revision is rejected, current records reload, and no blind overwrite is attempted", async () => {
  const data = fixture(),
    calls: Entry[][] = [];
  const app = await setup(
    "attendance",
    {
      save: async (entries) => {
        calls.push(entries);
        data.attendance = [
          {
            scout_id: scout,
            activity_id: activity,
            status: "absent",
            revision: 2,
            occurred_on: "2026-10-01",
          },
        ];
        throw Object.assign(
          new Error("Revision conflict; read current state"),
          { code: "P0001" },
        );
      },
    },
    data,
  );
  try {
    app.set("#activity-select", activity);
    app.set(`[data-attendance="${scout}"]`, "present");
    await app.submit('[data-form="attendance"]');
    assert.equal(calls.length, 1);
    assert.match(app.root.textContent!, /Someone updated these records/);
    assert.equal(
      (
        app.root.querySelector(`[data-attendance="${scout}"]`) as unknown as {
          value: string;
        }
      ).value,
      "absent",
    );
    assert.equal(app.root.querySelector('[data-action="retry"]'), null);
  } finally {
    app.close();
  }
});

test("equipment payments convert currency safely and use the global scout equipment revision", async () => {
  const app = await setup("scout/" + scout);
  try {
    app.click('[data-tab="equipment"]');
    app.set("#equipment-action", "pay_purchase");
    app.set('[name="amount"]', "12.34");
    await app.submit('[data-form="equipment"]');
    assert.equal(app.saved[0][0].command.amount_minor, 1234);
    assert.equal(app.saved[0][0].command.currency, "USD");
    assert.equal(app.saved[0][0].command.expected_revision, 7);
    assert.equal(app.saved[0][0].command.target_id, purchase);
    assert.equal(app.saved[0][0].command.action, "pay_purchase");
    assert.equal(app.saved[0][0].command.occurred_on, todayLA());
  } finally {
    app.close();
  }
});

test("adventure award and independent registration commands preserve dates and distinct actions", async () => {
  const app = await setup("adventures");
  try {
    const checkbox = app.root.querySelector(
      `input[name="scout_ids"][value="${scout}"]`,
    )! as unknown as { checked: boolean };
    checkbox.checked = true;
    app.set("#adventure-action", "earn_adventure");
    assert.equal(
      (app.root.querySelector("#award-note") as unknown as { hidden: boolean })
        .hidden,
      false,
    );
    await app.submit('[data-form="adventure"]');
    assert.equal(app.saved[0][0].command.action, "earn_adventure");
    assert.equal(app.saved[0][0].command.expected_revision, 2);
    assert.equal(app.saved[0][0].command.occurred_on, todayLA());
    assert.equal("badge_form" in app.saved[0][0].command, false);
    app.window.location.hash = "scout/" + scout;
    app.window.dispatchEvent(new app.window.Event("hashchange"));
    await flush();
    app.click('[data-tab="registration"]');
    app.set('[data-platform="scouting.org"] [name="status"]', "confirmed");
    app.set(
      '[data-platform="scouting.org"] [name="occurred_on"]',
      "2026-10-03",
    );
    await app.submit('[data-platform="scouting.org"]');
    assert.equal(app.saved[1][0].command.platform, "scouting.org");
    assert.equal(app.saved[1][0].command.expected_revision, 3);
    assert.equal(app.saved[1][0].command.occurred_on, "2026-10-03");
  } finally {
    app.close();
  }
});

test("untrusted scout names are text, and sign-out removes all loaded scout data", async () => {
  const data = fixture();
  data.scouts[0].scout_name = '<img src=x onerror="alert(1)">';
  const app = await setup("scouts", {}, data);
  try {
    assert.equal(app.root.querySelector("#workspace img"), null);
    assert.equal(app.root.querySelector("img[onerror]"), null);
    assert.ok(app.root.textContent!.includes("<img src=x"));
    app.signedOut();
    assert.doesNotMatch(app.root.textContent!, /img src=x|Second Synthetic/);
    assert.match(app.root.textContent!, /Continue with Google/);
  } finally {
    app.close();
  }
});

test("a late response after sign-out cannot restore the fieldbook", async () => {
  const window = new Window({ url: "https://pack99.example.invalid/prev/#scouts" });
  window.document.body.innerHTML = '<div id="app"></div>';
  let callback = () => {};
  let release!: (data: PortalData) => void;
  const service: PortalService = {
    identity: async () => ({ email: "leader@example.invalid" }),
    capabilities: async () => ({ approved: true, can_record: true }),
    load: () =>
      new Promise((resolve) => {
        release = resolve;
      }),
    save: async () => {},
    signIn: async () => {},
    signOut: async () => {},
    onSignOut: (cb) => {
      callback = cb;
      return () => {};
    },
  };
  const root = window.document.getElementById("app")!;
  const app = mountPortal(root as unknown as HTMLElement, service);
  try {
    await flush();
    callback();
    release(fixture());
    await app.ready;
    assert.doesNotMatch(root.textContent!, /First Synthetic/);
    assert.match(root.textContent!, /Continue with Google/);
  } finally {
    app.dispose();
    window.happyDOM.abort();
  }
});

test("pagination rejects incomplete lists and currency/date/link helpers preserve business semantics", async () => {
  assert.deepEqual(
    await collectPages(async (n) =>
      n === 0
        ? { rows: [1, 2], total: 3, next_offset: 2 }
        : { rows: [3], total: 3, next_offset: null },
    ),
    [1, 2, 3],
  );
  await assert.rejects(
    collectPages(async () => ({ rows: [1], total: 2, next_offset: null })),
    /complete list/,
  );
  await assert.rejects(
    collectPages(async (n) =>
      n === 0
        ? { rows: [1], total: 2, next_offset: 1 }
        : { rows: [2], total: 3, next_offset: null },
    ),
    /changed while loading/,
  );
  assert.equal(toMinor("12.34", "USD"), 1234);
  assert.equal(toMinor("12", "JPY"), 12);
  assert.equal(toMinor("1.234", "KWD"), 1234);
  assert.throws(() => toMinor("1.234", "USD"));
  assert.throws(() => toMinor("1.5", "JPY"));
  assert.equal(todayLA(new Date("2026-10-24T02:00:00Z")), "2026-10-23");
  assert.equal(safeSource("javascript:alert(1)"), "#");
  assert.equal(escapeHtml("<script>"), "&lt;script&gt;");
});

test("portal capability hints reflect current Google approval and separate recording grants", async () => {
  const { db, asUser } = await m2Fixture();
  try {
    const capabilities = (actor: number) =>
      asUser(actor, () =>
        db.query<{ r: { approved: boolean; can_record: boolean } }>(
          "select public.get_pack_capabilities() r",
        ),
      );
    assert.deepEqual((await capabilities(1)).rows[0].r, {
      approved: true,
      can_record: true,
      default_den: null,
    });
    assert.deepEqual((await capabilities(2)).rows[0].r, {
      approved: true,
      can_record: false,
      default_den: null,
    });
    assert.deepEqual((await capabilities(3)).rows[0].r, {
      approved: false,
      can_record: false,
      default_den: null,
    });
    await db.exec(
      "update leader_access set can_record=false where email='admin@example.test'",
    );
    assert.deepEqual((await capabilities(1)).rows[0].r, {
      approved: true,
      can_record: false,
      default_den: null,
    });
    await db.exec(
      "update leader_access set active=false where email='admin@example.test'",
    );
    assert.deepEqual((await capabilities(1)).rows[0].r, {
      approved: false,
      can_record: false,
      default_den: null,
    });
    await db.exec("set role anon");
    await assert.rejects(
      db.exec("select public.get_pack_capabilities()"),
      /permission denied/,
    );
    await db.exec("reset role");
  } finally {
    await db.close();
  }
});

test("pack attendance spans batches and an interrupted second batch never replays the first batch", async () => {
  const data = fixture();
  data.scouts = Array.from({ length: 42 }, (_, i) => ({
    id: id("1", i + 1),
    scout_name: `Synthetic Scout ${i + 1}`,
    den: "0-Lions",
  }));
  const calls: Entry[][] = [];
  let count = 0;
  const app = await setup(
    "attendance",
    {
      save: async (entries) => {
        calls.push(structuredClone(entries));
        count++;
        if (count === 2) throw new Error("Network interrupted");
      },
    },
    data,
  );
  try {
    app.set("#activity-select", activity);
    app.click('[data-action="all-present"]');
    await app.submit('[data-form="attendance"]');
    assert.deepEqual(
      calls.map((c) => c.length),
      [25, 17],
    );
    app.click('[data-action="retry"]');
    await flush();
    await flush();
    assert.deepEqual(
      calls.map((c) => c.length),
      [25, 17, 17],
    );
    assert.deepEqual(calls[2], calls[1]);
    assert.equal(new Set(calls[0].map((e) => e.request_id)).size, 25);
  } finally {
    app.close();
  }
});

test("Home opens initially, follows default den and den cards, and opens pending adventure work", async () => {
 const data=fixtureWithWithdrawals();
 data.scouts[1].den='1-Tigers';
 data.adventures[0].catalog_context={adventure_type:'Required (Core)'};
 data.progress=[{scout_id:scout,adventure_id:adventure,requirement_code:'1',completed_on:'2026-10-01',completion_source:'leader'}];
 const app=await setup('',{capabilities:async()=>({approved:true,can_record:true,default_den:'Lion'})},data);
 try {
  assert.equal(app.root.querySelector('[aria-current="page"]')?.textContent,'Home');
  assert.equal(app.root.querySelectorAll('.scout-trail').length,1);
  assert.match(app.root.querySelector('.journey-ring')!.getAttribute('aria-label')!,/0 of 1/);
  assert.ok(!app.root.querySelector('.home-dashboard')!.textContent!.includes('Withdrawn Synthetic'));
  app.set('#den-filter','');
  assert.equal(app.root.querySelectorAll('.scout-trail').length,2);
  app.click('[data-action="home-den"][data-den="0-Lions"]');
  assert.equal((app.root.querySelector('#den-filter') as unknown as {value:string}).value,'0-Lions');
  app.click('[data-action="plan-adventure"]');
  assert.equal(app.window.location.hash,'#adventures');
  assert.equal((app.root.querySelector('[name="requirement_code"]') as unknown as {value:string}).value,'2');
  assert.equal(app.saved.length,0);
 } finally {app.close();}
});

test('beta uses live service contract, bottom navigation and adventure-first form without changing the default UI',async()=>{
 const data=fixture();data.adventures[0].catalog_context={adventure_type:'Required (Core)'};
 const app=await setup('home',{},data,true);
 try {
  assert.equal(app.root.querySelector('.beta-banner'),null);
  assert.equal(app.root.querySelectorAll('.app-navigation a').length,6);
  assert.equal(app.root.querySelector('.app-navigation a[href^="/prev/events/?"]')?.textContent,'Events');
  app.click('[data-action="plan-adventure"]');
  assert.equal((app.root.querySelector('#den-filter') as unknown as {value:string}).value,'0-Lions');
  assert.equal(app.root.querySelector('[data-form="adventure"]')!.firstElementChild!.className,'completion-controls');
  app.click('[data-action="adventure-clear"]');
  app.click(`label:has(input[name="scout_ids"][value="${scout}"])`);
  await app.submit('[data-form="adventure"]');
  assert.equal(app.saved.length,1);assert.equal(app.saved[0][0].command.action,'record_requirement');
  assert.equal(app.saved[0][0].command.scout_id,scout);
 } finally{app.close();}
 const normal=await setup('home');try{assert.equal(normal.root.querySelector('.app-navigation'),null);assert.ok(normal.root.querySelector('.journey-hero'));}finally{normal.close();}
});

test('beta attendance saves selected scouts directly and preserves unselected records',async()=>{
 const app=await setup('attendance',{},fixture(),true);
 try{
  app.set('#activity-select',activity);
  app.click(`label:has(input[name="attendance_scout_ids"][value="${scout}"])`);
  assert.match(app.root.querySelector('[data-form="attendance"] button[type="submit"]')!.textContent!,/1 change/);
  await app.submit('[data-form="attendance"]');
  assert.equal(app.saved[0].length,1);assert.equal(app.saved[0][0].command.status,'present');assert.equal(app.saved[0][0].command.scout_id,scout);
 }finally{app.close();}
});

test('beta can cancel discarding a draft and still record against the captured revision',async()=>{
 const app=await setup('attendance',{},fixture(),true);
 try{
  app.set('#activity-select',activity);app.click(`label:has(input[name="attendance_scout_ids"][value="${scout}"])`);
  (app.window as unknown as {confirm:()=>boolean}).confirm=()=>false;
  app.set('#den-filter','0-Lions');
  assert.equal((app.root.querySelector('#den-filter') as unknown as {value:string}).value,'');
  assert.equal(app.root.querySelectorAll('[name="attendance_scout_ids"]:checked').length,1);
  await app.submit('[data-form="attendance"]');assert.equal(app.saved[0][0].command.expected_revision,0);
 }finally{app.close();}
});

test('beta respects read-only permissions and clears data on sign-out',async()=>{
 const app=await setup('adventures',{capabilities:async()=>({approved:true,can_record:false,default_den:'Lion'})},fixture(),true);
 try{assert.equal((app.root.querySelector('[name="scout_ids"]') as unknown as {disabled:boolean}).disabled,true);app.signedOut();assert.equal(app.root.querySelector('.app-navigation'),null);assert.ok(!app.root.textContent!.includes('First Synthetic'));}finally{app.close();}
});

test('default mount opens the new guided fieldbook without design switches', async()=>{
 const window=new Window({url:'https://pack99.example.invalid/'});
 window.document.body.innerHTML='<div id="app"></div>';const root=window.document.getElementById('app')!;
 const app=mountPortal(root as unknown as HTMLElement,{identity:async()=>({email:'leader@example.invalid'}),capabilities:async()=>({approved:true,can_record:true}),load:async()=>fixture(),save:async()=>{},signIn:async()=>{},signOut:async()=>{}});
 try{await app.ready;assert.ok(root.querySelector('.v2-actions'));assert.equal(root.querySelectorAll('.v2-bottom a').length,4);assert.equal(root.querySelector('[data-new-design],[data-original],[data-action=progress-classic]'),null);assert.equal(root.querySelector('.beta-banner'),null);assert.ok(!root.textContent!.includes('Current interface'));window.location.hash='more';window.dispatchEvent(new window.Event('hashchange'));assert.ok(root.querySelector('[data-app-signout]'));assert.ok(!root.textContent!.includes('Open the current interface'));}finally{app.dispose();window.happyDOM.abort();}
});

test('BSA identity appears in scout list and registration for readers without implying confirmation',async()=>{
 const data=fixture();data.scouts[0].bsa_member_id='001234567';
 const app=await setup('scouts',{capabilities:async()=>({approved:true,can_record:false})},data,true);
 try{
  assert.match(app.root.querySelector('table')!.textContent!,/BSA number/);assert.match(app.root.querySelector('table')!.textContent!,/001234567/);assert.match(app.root.querySelector('table')!.textContent!,/Not recorded/);
  app.window.location.hash='scout/'+scout;app.window.dispatchEvent(new app.window.Event('hashchange'));
  app.click('[data-action="profile-tab"][data-tab="registration"]');
  const national=[...app.root.querySelectorAll('.panel')].find(p=>p.querySelector('h2')?.textContent==='Scouting.org')!;
  assert.match(national.textContent!,/BSA member number/);assert.match(national.textContent!,/001234567/);assert.match(national.textContent!,/Needs verification/);assert.equal(app.saved.length,0);
 }finally{app.close();}
});

test('saved attendees are checked without a draft; adding a missing attendee saves only that correction',async()=>{
 const data=fixture();data.attendance=[{scout_id:scout,activity_id:activity,status:'present',revision:4,occurred_on:'2026-10-01'}];
 const app=await setup('attendance',{},data,true);
 try{
  app.set('#activity-select',activity);
  assert.equal(app.root.querySelectorAll('[name="attendance_scout_ids"]:checked').length,1);
  assert.equal((app.root.querySelector(`[name="attendance_scout_ids"][value="${scout}"]`)as unknown as{checked:boolean}).checked,true);
  assert.equal(app.root.querySelector('.beta-draft-note'),null);
  assert.equal((app.root.querySelector('[data-form="attendance"] button[type="submit"]')as unknown as{disabled:boolean}).disabled,true);
  let prompts=0;(app.window as unknown as {confirm:()=>boolean}).confirm=()=>{prompts++;return false;};
  app.set('#den-filter','0-Lions');assert.equal(prompts,0);
  app.click(`label:has(input[name="attendance_scout_ids"][value="${second}"])`);
  await app.submit('[data-form="attendance"]');
  assert.equal(app.saved[0].length,1);assert.equal(app.saved[0][0].command.scout_id,second);assert.equal(app.saved[0][0].command.status,'present');assert.equal(app.saved[0][0].command.expected_revision,0);
  // Reload reflects the service's saved data rather than retaining a stale selection.
  assert.equal(app.root.querySelectorAll('[name="attendance_scout_ids"]:checked').length,1);
 }finally{app.close();}
});

test('unchecking a saved attendee records absence using its revision, and undoing the toggle creates no draft',async()=>{
 const data=fixture();data.attendance=[{scout_id:scout,activity_id:activity,status:'present',revision:7,occurred_on:'2026-10-01'},{scout_id:second,activity_id:activity,status:'excused',revision:2,occurred_on:'2026-10-01'}];
 const app=await setup('attendance',{},data,true);
 try{
  app.set('#activity-select',activity);const label=`label:has(input[name="attendance_scout_ids"][value="${scout}"])`;
  app.click(label);assert.match(app.root.textContent!,/Saved: Present → Absent · Unsaved change/);
  app.click(label);assert.equal(app.root.querySelector('.beta-draft-note'),null);
  app.click(label);await app.submit('[data-form="attendance"]');
  assert.equal(app.saved[0].length,1);assert.equal(app.saved[0][0].command.scout_id,scout);assert.equal(app.saved[0][0].command.status,'absent');assert.equal(app.saved[0][0].command.expected_revision,7);
 }finally{app.close();}
});

test('session changes restore each saved selection and search does not discard explicit attendance edits',async()=>{
 const data=fixture(),other=id('2',2);data.activities.push({...data.activities[0],id:other,title:'Other session'});data.attendance=[{scout_id:scout,activity_id:activity,status:'present',revision:1,occurred_on:'2026-10-01'},{scout_id:second,activity_id:other,status:'present',revision:2,occurred_on:'2026-10-01'}];
 const app=await setup('attendance',{},data,true);
 try{
  app.set('#activity-select',activity);app.set('#activity-select',other);
  assert.equal((app.root.querySelector(`[name="attendance_scout_ids"][value="${second}"]`)as unknown as{checked:boolean}).checked,true);
  assert.equal((app.root.querySelector(`[name="attendance_scout_ids"][value="${scout}"]`)as unknown as{checked:boolean}).checked,false);
  app.set('#activity-select',activity);app.click(`label:has(input[name="attendance_scout_ids"][value="${second}"])`);
  const search=app.root.querySelector('#global-search')as unknown as{value:string;dispatchEvent(e:unknown):void};search.value='First';search.dispatchEvent(new app.window.Event('input',{bubbles:true}));
  await app.submit('[data-form="attendance"]');assert.equal(app.saved[0].length,1);assert.equal(app.saved[0][0].command.scout_id,second);
 }finally{app.close();}
});

test('leaders assign selected scouts to parents without recording completion and preserve instructions while selecting',async()=>{
 const app=await setup('adventures',{},fixture(),true);
 try{
  app.set('#adventure-action','assign_requirement');
  const note=app.root.querySelector('[name=instructions]')as unknown as{value:string;dispatchEvent(e:unknown):void};note.value='Explore with your family';note.dispatchEvent(new app.window.Event('input',{bubbles:true}));
  app.click(`label:has(input[name="scout_ids"][value="${scout}"])`);
  assert.equal((app.root.querySelector('[name=instructions]')as unknown as{value:string}).value,'Explore with your family');
  await app.submit('[data-form=adventure]');assert.equal(app.saved[0].length,1);assert.equal(app.saved[0][0].command.action,'assign_requirement');assert.equal(app.saved[0][0].command.scout_id,scout);assert.equal(app.saved[0][0].command.instructions,'Explore with your family');assert.equal(app.saved[0][0].command.requirement_code,'1');
 }finally{app.close();}
});
test('leaders can review parent submissions and reply through family workspace',async()=>{
 const data=fixture();data.assignments=[{id:'assignment',scout_id:scout,adventure_id:adventure,scouting_year:'2026-27',requirement_code:'1',instructions:'Practice',assigned_on:'2026-10-01',due_on:null,status:'submitted',completed_on:'2026-10-14',parent_note:'Done at home',submitted_at:'2026-10-15T12:00:00Z',review_note:'',reviewed_at:null,revision:2}];
 const app=await setup('families',{},data,true);
 try{
  assert.match(app.root.textContent!,/Done at home/);await app.submit('[data-form=family-review]');assert.equal(app.saved[0][0].command.action,'review_assignment');assert.equal(app.saved[0][0].command.decision,'approve');assert.equal(app.saved[0][0].command.expected_revision,2);
  const body=app.root.querySelector('[data-form=family-message] [name=body]')as unknown as{value:string};body.value='Great work!';await app.submit('[data-form=family-message]');assert.equal(app.saved[1][0].command.action,'send_family_message');assert.equal(app.saved[1][0].command.as_role,'leader');assert.equal(app.saved[1][0].command.scout_id,scout);
 }finally{app.close();}
});

test('whole-adventure home assignment skips completed and already-assigned requirements per scout',async()=>{
 const data=fixture();data.progress=[{scout_id:scout,adventure_id:adventure,requirement_code:'1',completed_on:'2026-10-14',completion_source:'individual'}];data.assignments=[{id:'existing',scout_id:second,adventure_id:adventure,scouting_year:'2026-27',requirement_code:'2',instructions:'',assigned_on:'2026-10-01',due_on:null,status:'todo',completed_on:null,parent_note:'',submitted_at:null,review_note:'',reviewed_at:null,revision:1}];
 const app=await setup('adventures',{},data,true);try{app.set('#adventure-action','assign_requirement');app.set('[name=requirement_code]','*');app.click('[data-action=adventure-select-all]');await app.submit('[data-form=adventure]');assert.equal(app.saved[0].length,2);assert.deepEqual(app.saved[0].map(e=>[e.command.scout_id,e.command.requirement_code]),[[scout,'2'],[second,'1']]);}finally{app.close();}
});


test('guided progress makes explicit choices, uses portraits, preserves selection on Back and saves only eligible scouts', async()=>{
 const data=fixture();data.photos=[{scout_id:scout,image:'data:image/png;base64,AA=='}];
 data.progress=[{scout_id:scout,adventure_id:adventure,requirement_code:'1',completed_on:'2026-10-01',completion_source:'individual'}];
 const app=await setup('adventures',{},data,true,true);
 try {
  assert.match(app.root.textContent!,/What progress do you want to record/);
  assert.equal(app.root.querySelector('form[data-form=adventure]'),null);
  app.click('[data-action=wizard-action][data-value=record_requirement]');
  app.click(`[data-action=wizard-adventure][data-value="${adventure}"]`);
  app.click('[data-action=wizard-requirement][data-value="1"]');
  assert.equal(app.root.querySelectorAll('.progress-scout img').length,1);
  assert.equal((app.root.querySelector(`input[value="${scout}"]`)as any).disabled,true);
  app.click('[data-action=wizard-all]');
  assert.equal(app.root.querySelectorAll('input[name=scout_ids]:checked').length,1);
  app.click('[data-action=wizard-back]');
  app.click('[data-action=wizard-requirement][data-value="2"]');
  assert.equal(app.root.querySelectorAll('input[name=scout_ids]:checked').length,0);
  app.click('[data-action=wizard-all]');app.set('[name=occurred_on]','2026-10-14');
  await app.submit('[data-form=adventure]');
  assert.equal(app.saved[0].length,2);
  assert.ok(app.saved[0].every(e=>e.command.action==='record_requirement'&&e.command.requirement_code==='2'&&e.command.status==='completed'));
  assert.equal(app.saved[0][0].command.expected_revision,2);
 }finally{app.close();}
});

test('guided corrections undo requirements, enforce delivered award ordering and retain Classic view preference',async()=>{
 const data=fixture();data.progress=[{scout_id:scout,adventure_id:adventure,requirement_code:'1',completed_on:'2026-10-01',completion_source:'individual'}];
 const app=await setup('adventures',{},data,true,true);
 try{
  app.click('[data-action=wizard-action][data-value=undo_requirement]');app.click(`[data-action=wizard-adventure][data-value="${adventure}"]`);app.click('[data-action=wizard-requirement][data-value="1"]');app.click('[data-action=wizard-all]');
  await app.submit('[data-form=adventure]');
  assert.equal(app.saved[0].length,1);assert.equal(app.saved[0][0].command.status,'not_completed');assert.equal(app.saved[0][0].command.action,'record_requirement');
  app.click('[data-action=progress-classic]');assert.ok(app.root.querySelector('#adventure-action'));assert.equal(app.window.localStorage.getItem('pack99-progress-view'),'classic');
  app.click('[data-action=progress-guided]');assert.match(app.root.textContent!,/What progress/);assert.equal(app.window.localStorage.getItem('pack99-progress-view'),'guided');
 }finally{app.close();}
});


test('guided award undo offers only undelivered earned adventures and requires a correction reason',async()=>{
 const data=fixture();data.advancement=[{scout_id:scout,adventure_id:adventure,revision:9,earned_on:'2026-10-10',badge_delivered_on:'2026-10-12',badge_form:'belt_loop'},{scout_id:second,adventure_id:adventure,revision:4,earned_on:'2026-10-11',badge_delivered_on:null,badge_form:null}];
 const app=await setup('adventures',{},data,true,true);
 try{
  app.click('[data-action=wizard-action][data-value=revoke_adventure]');app.click(`[data-action=wizard-adventure][data-value="${adventure}"]`);
  assert.equal((app.root.querySelector(`input[value="${scout}"]`)as any).disabled,true);
  app.click('[data-action=wizard-all]');app.set('[name=reason]','Selected the wrong scout');await app.submit('[data-form=adventure]');
  assert.equal(app.saved[0].length,1);assert.equal(app.saved[0][0].command.scout_id,second);assert.equal(app.saved[0][0].command.expected_revision,4);assert.equal(app.saved[0][0].command.reason,'Selected the wrong scout');assert.equal(app.saved[0][0].command.action,'revoke_adventure');
 }finally{app.close();}
});

test('opening guided progress from Home scrolls to the steps rather than the page header',async()=>{
 const app=await setup('home',{},fixture(),true,true);
 const prototype=(app.window as any).HTMLElement.prototype,original=prototype.scrollIntoView,scrolled:string[]=[];
 prototype.scrollIntoView=function(){scrolled.push(this.id);};
 try{
  app.window.location.hash='adventures';app.window.dispatchEvent(new app.window.Event('hashchange'));
  assert.ok(scrolled.includes('record-progress-steps'));
  assert.equal(app.window.document.activeElement?.id,'record-progress-steps');
  scrolled.length=0;app.click('[data-action=wizard-action][data-value=record_requirement]');assert.equal(scrolled.length,0);
 }finally{prototype.scrollIntoView=original;app.close();}
});

test('Classic progress and scout fieldbook reference official remote artwork beside adventure labels',async()=>{
 const data=fixture(),real='11111111-2222-4333-8444-555555555555';data.adventures[0].id=real;data.adventures[0].name='Bobcat';data.adventures[0].rank='lion';
 const app=await setup('adventures',{},data,true);
 try{
  assert.match(app.root.querySelector('.adventure-art-title img')?.getAttribute('src') || '',/^https:\/\/www\.scouting\.org\/wp-content\/uploads\//);
  assert.ok(app.root.querySelector('.adventure-art-title')?.textContent?.includes(data.adventures[0].name));
  app.window.location.hash=`scout/${scout}/adventures`;app.window.dispatchEvent(new app.window.Event('hashchange'));
  assert.match(app.root.querySelector('.scout-adventure summary img')?.getAttribute('src') || '',/^https:\/\/www\.scouting\.org\/wp-content\/uploads\//);
  assert.ok(app.root.querySelector('.scout-adventure summary')?.textContent?.includes(data.adventures[0].name));
 }finally{app.close();}
});
