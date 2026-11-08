import { test } from "node:test";
import assert from "node:assert/strict";
import { googleCallbackError } from "../auth-ui/auth-errors.ts";

test("first-time sign-in errors explain the configuration problem in query or fragment", () => {
  for (const separator of ["?", "#"]) {
    const url = new URL(`https://legacy.packpilot.example/oauth/consent${separator}error=access_denied&error_code=signup_disabled`);
    const message = googleCallbackError(url, true)!;
    assert.match(message, /First-time Google sign-in is disabled/);
    assert.match(message, /leader approval is still required/);
  }
});

test("provider descriptions stay private and retries match the login flow", () => {
  const url = new URL("https://legacy.packpilot.example/oauth/consent?error=access_denied&error_description=secret-email-or-provider-details");
  const portal = googleCallbackError(url, true)!;
  assert.doesNotMatch(portal, /secret-email/);
  assert.match(portal, /Safari or Chrome/);
  assert.match(googleCallbackError(url, false)!, /reconnect from your assistant/);
  assert.equal(googleCallbackError(new URL("https://legacy.packpilot.example/oauth/consent?code=example"), true), null);
});

test("expired OAuth state offers a recoverable browser retry", () => {
  const message = googleCallbackError(new URL("https://legacy.packpilot.example/oauth/consent#error=access_denied&error_code=bad_oauth_state"), true)!;
  assert.match(message, /session expired/);
  assert.match(message, /Continue with Google/);
});
