import { test } from "node:test";
import assert from "node:assert/strict";
import { derive, queryRoster, validDate } from "../supabase/functions/_shared/query.ts";

const roster = [
  { id: "a", source_row: 2, scout_name: "Adam One", den: "0-Lions", birth_date: "2016-02-29", parent_1_name: "Parent A", allergy: "Peanuts", snapshot_date: "2026-10-21" },
  { id: "b", source_row: 3, scout_name: "Adam Two", den: "1-Tigers", birth_date: "2017-12-31", parent_1_phone: "012345", parent_2_email: "parent@example.test", allergy: "No peanut allergy", snapshot_date: "2026-10-21" },
  { id: "c", source_row: 4, scout_name: "Adama Three", den: "(withdraw) 0-Lions", birth_date: null, participant_email: "scout@example.test", allergy: null },
  { id: "d", source_row: 5, scout_name: "Taylor Four", den: null, birth_date: "2018-01-01", parent_2_name: "Parent D", allergy: "Possible peanut sensitivity" },
];

test("filters normalize den and preserve withdrawal distinctions", () => {
  const all = queryRoster(roster, { filters: [{ field: "den_name", op: "eq", value: "lions" }] });
  assert.equal(all.total, 2);
  const active = queryRoster(roster, { filters: [{ field: "den_name", op: "eq", value: "Lions" }, { field: "withdrawn", op: "eq", value: false }] });
  assert.equal(active.total, 1);
});
test("first-name count is exact and independent of pagination", () => {
  const result = queryRoster(roster, { filters: [{ field: "first_name", op: "eq", value: "adam" }], limit: 1, metrics: [{ op: "count" }] });
  assert.equal(result.total, 2);
  assert.equal(result.metrics[0].value, 2);
  assert.equal(result.next_offset, 1);
  assert.equal("rows" in result && result.rows.length, 1);
});
test("contact presence uses either parent slot but not participant email", () => {
  const result = queryRoster(roster, { filters: [{ field: "parent_contact_count", op: "eq", value: 1 }] });
  assert.equal(result.total, 2);
  assert.equal(derive(roster[2], "2026-01-01").parent_contact_count, 0);
});
test("health fields and old medical operators cannot be queried or returned", () => {
  for (const field of ['allergy','medication','medical_conditions']) {
    for(const query of [{select:[field]},{filters:[{field,op:'present'}]},{group_by:field},{metrics:[{op:'count_present',field}]}]) assert.throws(()=>queryRoster(roster,query));
  }
  assert.throws(()=>queryRoster(roster,{filters:[{field:'scout_name',op:'allergy_match',value:'test'}]}));
  assert.ok(!('allergy' in derive(roster[0],'2026-11-02')));
  assert.ok(!JSON.stringify(queryRoster(roster,{})).includes('Peanuts'));
});
test("missing values remain unknown; OR combines with AND",()=>{
 assert.equal(queryRoster(roster,{filters:[{field:'birth_date',op:'missing'}]}).total,1);
 assert.equal(queryRoster(roster,{filters:[{field:'withdrawn',op:'eq',value:false}],any_of:[{field:'first_name',op:'eq',value:'Adam'},{field:'birth_date',op:'missing'}]}).total,2);
});
test("dates, leap days, year boundaries, and missing DOB are explicit", () => {
  assert.equal(validDate("2026-02-29"), false);
  assert.equal(derive(roster[0], "2027-02-27").age, 10);
  assert.equal(derive(roster[0], "2027-02-28").age, 11);
  assert.equal(derive(roster[0], "2027-02-28").days_to_birthday, 0);
  assert.equal(derive(roster[1], "2026-12-30").days_to_birthday, 1);
  assert.equal(derive(roster[3], "2026-12-30").days_to_birthday, 2);
  assert.equal(derive(roster[2], "2026-12-30").age, null);
  assert.equal(derive({ birth_date: "2030-01-01" }, "2026-12-30").age, null);
  const result = queryRoster(roster, {}, new Date("2026-10-22T02:00:00Z"));
  assert.equal(result.as_of, "2026-10-21");
});
test("grouping includes null groups; metrics use all matches and report missingness", () => {
  const result = queryRoster(roster, { group_by: "den_name", limit: 1, metrics: [{ op: "count_present", field: "birth_date" }, { op: "avg", field: "age" }], as_of: "2026-10-21" });
  assert.equal(result.total, 4);
  assert.equal(result.metrics[0].value, 3);
  assert.equal(result.metrics[0].missing, 1);
  assert.equal("total_groups" in result && result.total_groups, 3);
  assert.equal(result.next_offset, 1);
});
test("invalid fields, executable queries, bad operators and unbounded requests are rejected", () => {
  for (const q of [
    { sql: "DELETE FROM scouts" },
    { select: ["source_values"] },
    { filters: [{ field: "scout_name); DROP TABLE scouts", op: "eq", value: "Adam" }] },
    { filters: [{ field: "age", op: "gte", value: "5" }] },
    { filters: [{ field: "den", op: "eq" }] },
    { filters: [{ field: "allergy", op: "missing", value: "x" }] },
    { metrics: [{ op: "avg", field: "scout_name" }] },
    { as_of: "2026-02-30" }, { limit: 101 }, { offset: -1 },
  ]) assert.throws(() => queryRoster(roster, q));
  assert.throws(() => queryRoster(Array(10001).fill(roster[0]), {}), /capacity/);
});
