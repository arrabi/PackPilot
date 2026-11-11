import {assistantEnvironmentEnabled} from '../supabase/functions/_shared/assistant-environment.ts';
import './back-navigation.css';
import './assistant.css';
import {assistantTransport} from './assistant-client.ts';
import {isV2} from './v2-shell.ts';
import './v2.css';
import './notes.css';
import './policy.css';
import './app-shell.css';
import {requirePolicies} from './policy-gate.ts';
import { createClient } from "@supabase/supabase-js";
import { recordOperationSchema } from "../supabase/functions/_shared/operations.ts";
import { mountPortal, type PortalService } from "./portal-ui.ts";
import { collectPages, type Page, type PortalData } from "./portal-model.ts";
const root = document.getElementById("app")!;
const url = import.meta.env.VITE_SUPABASE_URL,
  key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
if (!url || !key) {
  root.textContent =
    "The pack administrator needs to configure Google sign-in before this fieldbook can be opened.";
} else {
  const client = createClient(url, key, {
    auth: { flowType: "pkce", detectSessionInUrl: false },
  });
  async function rpc<T>(
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<T> {
    const { data, error } = await client
      .rpc(name, args)
      .abortSignal(AbortSignal.timeout(20000));
    if (error)
      throw Object.assign(new Error(error.message), {
        code: error.code || undefined,
      });
    return data as T;
  }
  const service: PortalService = {
    ...(assistantEnvironmentEnabled(import.meta.env.MODE)?{assistant:assistantTransport(client,url,key)}:{}),
    async identity() {
      const { data, error } = await client.auth.getUser();
      if (error || !data.user) return null;
      await requirePolicies(client);
      return { email: data.user.email || "Google account" };
    },
    capabilities: async () => {const [caps,prefs]=await Promise.all([rpc<{approved:boolean;can_record:boolean;default_den?:string|null}>("get_pack_capabilities"),rpc<{is_admin:boolean}>("read_pack_email_preferences")]);return {...caps,is_admin:prefs.is_admin};},
    async load(year) {
      const pages = <T>(name: string, args: Record<string, unknown>) =>
        collectPages<T>((offset) =>
          rpc<Page<T>>(name, { ...args, page_offset: offset, page_limit: 100 }),
        );
      const [
        scouts,
        activities,
        attendance,
        registrations,
        adventures,
        advancement,
        progress,
        events,
        loans,
        losses,
        purchases,
        eligibility,
        summary,
        inventory,
        inventoryEvents,
        denPlans,
        familyWork,
      ] = await Promise.all([
        rpc<PortalData["scouts"]>("read_roster_snapshot"),
        pages<PortalData["activities"][number]>("read_pack_operations", {
          entity: "activities",
          scouting_year: year,
        }),
        pages<PortalData["attendance"][number]>("read_pack_operations", {
          entity: "attendance",
          scouting_year: year,
        }),
        pages<PortalData["registrations"][number]>("read_pack_operations", {
          entity: "registrations",
          scouting_year: year,
        }),
        pages<PortalData["adventures"][number]>("read_pack_advancement", {
          entity: "adventures",
        }),
        pages<PortalData["advancement"][number]>("read_pack_advancement", {
          entity: "advancement",
          scouting_year: year,
        }),
        pages<PortalData["progress"][number]>("read_pack_advancement", {
          entity: "requirements",
          scouting_year: year,
        }),
        pages<PortalData["events"][number]>("read_pack_equipment", {
          entity: "events",
          scouting_year: year,
        }),
        pages<PortalData["loans"][number]>("read_pack_equipment", {
          entity: "loans",
          scouting_year: year,
        }),
        pages<PortalData["losses"][number]>("read_pack_equipment", {
          entity: "losses",
          scouting_year: year,
        }),
        pages<PortalData["purchases"][number]>("read_pack_equipment", {
          entity: "purchases",
          scouting_year: year,
        }),
        pages<PortalData["eligibility"][number]>("read_pack_equipment", {
          entity: "eligibility",
          scouting_year: year,
        }),
        pages<PortalData["summary"][number]>("read_pack_report", {
          report: "scout_summary",
          scouting_year: year,
        }),
        pages<PortalData["inventory"][number]>("read_pack_inventory", { entity: "items" }),
        pages<PortalData["inventoryEvents"][number]>("read_pack_inventory", { entity: "events" }),
        rpc<PortalData["denPlans"]>("read_pack_den_plans", { scouting_year: year }),
        rpc<Pick<PortalData,"assignments"|"familyMessages">>("read_leader_family_work",{scouting_year:year}),
      ]);
      return {
        scouts,activities,attendance,registrations,adventures,advancement,progress,events,loans,losses,purchases,eligibility,summary,inventory,inventoryEvents,denPlans,
        ...(isV2(window)?{calendarEvents:(await rpc<{events: NonNullable<PortalData['calendarEvents']>}>('read_pack_workspace',{view_name:'events',as_parent:false,scouting_year:year})).events}:{}),
        ...familyWork,
        registrationReports:await rpc("read_pack_registration_reports",{scouting_year:year}),
        photos: await rpc("read_scout_photos"),
        attribution: await rpc("read_scout_attribution_bulk"),
      };
    },
    loadPhotos:(child)=>rpc("read_scout_photo_pair",{child}),
    loadFamily:(year)=>rpc("read_leader_family_work",{scouting_year:year}),
    async saveFamily(entries){const results=await rpc<{notifications_queued?:number}[]>("record_family_batch",{entries});return{notificationsQueued:results.reduce((n,r)=>n+(r.notifications_queued||0),0)};},
    async save(entries) {
      let parsed;
      try {
        parsed = entries.map((e) => recordOperationSchema.parse(e));
      } catch {
        throw Object.assign(new Error("Check the form fields before saving."), {
          definitive: true,
        });
      }
      const results=await rpc<{notifications_queued?:number}[]>("record_pack_batch", { entries: parsed });
      return{notificationsQueued:results.reduce((n,r)=>n+(r.notifications_queued||0),0)};
    },
    async signIn() {
      const redirect = new URL("/oauth/consent", location.origin);
      redirect.searchParams.set("portal", "1");
      redirect.searchParams.set("return_to",new URL(location.href).searchParams.get("return_to")||location.pathname+location.search+location.hash);
      const { error } = await client.auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo: redirect.href,
          queryParams: { prompt: "select_account" },
        },
      });
      if (error) throw error;
    },
    async signOut() {
      const { error } = await client.auth.signOut();
      if (error)
        throw new Error("Sign-out did not complete. Please try again.");
    },
    onSignOut(callback) {
      const { data } = client.auth.onAuthStateChange((event) => {
        if (event === "SIGNED_OUT") callback();
      });
      return () => data.subscription.unsubscribe();
    },
  };
  mountPortal(root, service);
}
