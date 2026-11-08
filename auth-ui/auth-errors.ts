/** Show actionable OAuth errors without rendering provider-supplied descriptions. */
export function googleCallbackError(callback: URL, portal: boolean): string | null {
  const fragment = new URLSearchParams(callback.hash.replace(/^#/, ""));
  const value = (name: string) => callback.searchParams.get(name) || fragment.get(name);
  if (!value("error") && !value("error_code")) return null;
  const retry = portal
    ? "Try Continue with Google again. If you opened this from WhatsApp, open the portal in Safari or Chrome first."
    : "Try Continue with Google again, or reconnect from your assistant.";
  if (value("error_code") === "signup_disabled" || value("error") === "signup_disabled")
    return "First-time Google sign-in is disabled in the authentication service. Ask the pack administrator to enable first-time sign-in; your PackPilot leader approval is still required.";
  if (value("error_code") === "bad_oauth_state" || value("error_code") === "flow_state_not_found")
    return `Your sign-in session expired or could not be found. ${retry}`;
  return `Google sign-in was cancelled or could not be completed. ${retry}`;
}
