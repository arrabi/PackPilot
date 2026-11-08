import{safeLeaderReturn}from'./app-shell.ts';
import './policy.css';
import {requirePolicies} from './policy-gate.ts';
import { createClient } from "@supabase/supabase-js";
import { googleCallbackError } from "./auth-errors.ts";

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const status = element("status");
const login = element<HTMLButtonElement>("login");
const approve = element<HTMLButtonElement>("approve");
const deny = element<HTMLButtonElement>("deny");
const logout = element<HTMLButtonElement>("logout");
const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
const id = new URL(location.href).searchParams.get("authorization_id");
const leaderReturn=safeLeaderReturn(new URL(location.href).searchParams.get("return_to"));
const parentPreview = new URL(location.href).searchParams.get("parent_preview") === "1";
const returnToPortal = new URL(location.href).searchParams.get("portal") === "1";

async function main() {
  if (!url || !key) throw new Error("The administrator needs to configure the sign-in page before it can be used.");
  const supabase = createClient(url, key, { auth: { flowType: "pkce", detectSessionInUrl: false } });
  if (returnToPortal) {
    document.title = "PackPilot · Leader sign-in";
    document.querySelector("h1")!.textContent = "Open your leader fieldbook.";
    document.querySelector(".intro")!.textContent = "Sign in with your approved Google account to open the PackPilot leader portal.";
  }
  login.onclick = async () => {
    login.disabled = true;
    const redirect = new URL("/oauth/consent", location.origin);
    if (id) redirect.searchParams.set("authorization_id", id);
    else if (returnToPortal) { redirect.searchParams.set("portal", "1");redirect.searchParams.set("return_to",leaderReturn); if (parentPreview) redirect.searchParams.set("parent_preview", "1"); }
    const { error } = await supabase.auth.signInWithOAuth({ provider: "google", options: { redirectTo: redirect.href, queryParams: { prompt: "select_account" } } });
    if (error) { status.textContent = "Could not start Google sign-in. Please retry."; login.disabled = false; }
  };
  const callbackUrl = new URL(location.href);
  const providerError = googleCallbackError(callbackUrl, returnToPortal);
  const code = callbackUrl.searchParams.get("code");
  const cleanCallback = () => {
    const clean = new URL(location.pathname, location.origin);
    if (id) clean.searchParams.set("authorization_id", id);
    else if (returnToPortal) { clean.searchParams.set("portal", "1");clean.searchParams.set("return_to",leaderReturn); if (parentPreview) clean.searchParams.set("parent_preview", "1"); }
    history.replaceState(null, "", clean.pathname + clean.search);
  };
  if (providerError) {
    cleanCallback();
    status.textContent = providerError;
    login.hidden = false;
    return;
  }
  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    // Remove short-lived codes while retaining the intended flow on refresh/retry.
    cleanCallback();
    if (error) {
      status.textContent = "Could not finish sign-in in this browser. Try Continue with Google again in the same Safari or Chrome browser where you started.";
      login.hidden = false;
      return;
    }
  }
  const { data: { user } } = await supabase.auth.getUser();
  logout.onclick = async () => {
    const { error } = await supabase.auth.signOut();
    if (error) { status.textContent = "Sign-out failed. Please retry."; return; }
    location.reload();
  };
  if (!user) {
    status.textContent = "Sign in with your approved Google account to continue.";
    login.hidden = false; return;
  }
  logout.hidden = false;
  await requirePolicies(supabase);
  const { data: approved, error: approvalError } = await supabase.rpc("is_approved_leader");
  if (approvalError) throw new Error("Could not check roster access. Please contact the administrator.");
  if (!approved) throw new Error("This Google account is not approved. Ask the pack administrator for access, or sign out to use another account.");
  if (!id && returnToPortal) { location.replace(parentPreview ? (/^\/(?:(?:v2|prev)\/)?parents\/?(?:[?#]|$)/.test(leaderReturn)?leaderReturn:"/parents?preview=1") : leaderReturn); return; }
  if (!id) { status.textContent = `Signed in as ${user.email}. Start a connection from your AI assistant to authorize roster access.`; return; }
  const { data, error } = await supabase.auth.oauth.getAuthorizationDetails(id);
  if (error || !data) throw new Error("This connection request is invalid or expired. Reconnect from your assistant.");
  function redirectToClient(target: string) {
    // Target comes only from Supabase's validated OAuth request, never a URL parameter.
    const destination = new URL(target);
    if (destination.protocol !== "https:" && !(destination.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(destination.hostname))) throw new Error("Unsupported client return address");
    location.assign(destination.href);
  }
  if ("redirect_url" in data) { redirectToClient(data.redirect_url); return; }
  element("email").textContent = user.email ?? "Google account";
  element("client").textContent = data.client.name;
  element("redirect").textContent = data.redirect_uri;
  element("scopes").textContent = data.scope || "Basic identity";
  element("details").hidden = false;
  status.textContent = "Review this application before granting access.";
  approve.hidden = deny.hidden = false;
  const consent = async (allow: boolean) => {
    approve.disabled = deny.disabled = true;
    try {
      if (allow) {
        const { data, error } = await supabase.rpc("is_approved_leader");
        if (error || !data) throw new Error("Roster access is no longer approved.");
      }
      const { data, error } = allow
        ? await supabase.auth.oauth.approveAuthorization(id, { skipBrowserRedirect: true })
        : await supabase.auth.oauth.denyAuthorization(id, { skipBrowserRedirect: true });
      if (error || !data) throw new Error("This authorization request expired or could not be completed. Reconnect from your assistant.");
      redirectToClient(data.redirect_url);
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : "Unable to complete authorization";
      approve.disabled = deny.disabled = false;
    }
  };
  approve.onclick = () => void consent(true);
  deny.onclick = () => void consent(false);
}

main().catch(error => {
  status.textContent = error instanceof Error ? error.message : "Connection unavailable";
  approve.hidden = deny.hidden = true;
});
