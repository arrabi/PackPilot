import {test} from 'node:test';
import assert from 'node:assert/strict';
import {portalTransition} from '../auth-ui/domain-transition.ts';

test('old portal visits retain deep links, queries and fragment routes', () => {
  for (const path of ['/', '/events?parent=1&job=123', '/?year=2026#scout/123/registration', '/parents?child=123&section=progress']) {
    assert.equal(portalTransition(new URL('https://legacy.packpilot.example'+path)), 'https://packpilot.example'+path);
  }
});
test('callbacks and other origins stay on their original origin', () => {
  for (const path of ['/oauth/consent?code=123', '/consent.html', '/?code=123', '/#access_token=secret', '/?error=access_denied', '/?authorization_id=123']) {
    assert.equal(portalTransition(new URL('https://legacy.packpilot.example'+path)), null);
  }
  for (const origin of ['https://packpilot.example', 'https://packpilot-site.pages.dev', 'https://legacy.packpilot.example.evil.test']) {
    assert.equal(portalTransition(new URL(origin)), null);
  }
});
