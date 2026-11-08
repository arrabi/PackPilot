import { compareAdventures, denRank, isWithdrawnScout, type Adventure, type PortalData, type Scout } from "./portal-model.ts";

export function needsAdventureAction(data: PortalData, scout: Scout, adventure: Adventure, action: string, requirement?: string): boolean {
  if (isWithdrawnScout(scout) || denRank(scout.den) !== adventure.rank) return false;
  const state = data.advancement.find((v) => v.scout_id === scout.id && v.adventure_id === adventure.id);
  if (action === "deliver_badge") return !!state?.earned_on && !state.badge_delivered_on;
  if (state?.earned_on) return false;
  if (action === "earn_adventure") return true;
  const missing = (code: string) => !data.progress.some((p) => p.scout_id === scout.id && p.adventure_id === adventure.id && p.requirement_code === code) && (action !== "assign_requirement" || !data.assignments.some(a => a.scout_id === scout.id && a.adventure_id === adventure.id && a.requirement_code === code && ["todo","submitted","returned"].includes(a.status)));
  return requirement ? missing(requirement) : adventure.requirements.some((r) => missing(r.code));
}

export function denRecommendations(data: PortalData, den: string) {
  const scouts = data.scouts.filter((s) => !isWithdrawnScout(s) && s.den === den);
  const adventures = data.adventures.filter((a) => a.rank === denRank(den));
  const required = adventures.filter((a) => a.catalog_context?.adventure_type === "Required (Core)");
  const elective = adventures.filter((a) => a.catalog_context?.adventure_type === "Elective");
  const need = (a: Adventure) => scouts.filter((s) => needsAdventureAction(data, s, a, "earn_adventure"));
  const pending = required.map((adventure) => ({ adventure, scouts: need(adventure), requirements: adventure.requirements.map((r) => ({ ...r, needed: scouts.filter((s) => needsAdventureAction(data, s, adventure, "record_requirement", r.code)).length })).filter((r) => r.needed > 0).sort((a,b) => b.needed - a.needed) }))
    .filter((v) => v.scouts.length > 0).sort((a,b) => b.scouts.length - a.scouts.length || compareAdventures(a.adventure,b.adventure));
  return { scouts, required, elective: elective.sort(compareAdventures), pending, allRequiredEarned: scouts.length > 0 && required.length > 0 && pending.length === 0, need };
}
