import assert from 'node:assert/strict';
import {test} from 'node:test';
import {deploymentOrigins} from '../supabase/functions/_shared/deployment-origins.ts';

test('MCP startup accepts both isolated staging hostnames and permits their browser origins', () => {
  for (const origin of ['https://packpilot-staging.pages.dev', 'https://staging.packpilot.example']) {
    const result = deploymentOrigins('https://bbbbbbbbbbbbbbbbbbbb.supabase.co', 'staging', origin);
    assert.equal(result.allowedOrigin, origin);
    assert.ok(result.allowedOrigins.includes('https://staging.packpilot.example'));
    assert.ok(result.allowedOrigins.includes('https://packpilot-staging.pages.dev'));
  }
});

test('MCP startup rejects crossed projects, production origins on staging and lookalike staging hosts', () => {
  for (const [url, env, origin] of [
    ['https://aaaaaaaaaaaaaaaaaaaa.supabase.co', 'staging', 'https://staging.packpilot.example'],
    ['https://bbbbbbbbbbbbbbbbbbbb.supabase.co', 'production', 'https://packpilot.example'],
    ['https://bbbbbbbbbbbbbbbbbbbb.supabase.co', 'staging', 'https://packpilot.example'],
    ['https://bbbbbbbbbbbbbbbbbbbb.supabase.co', 'staging', 'https://staging.packpilot.example.example.com'],
    ['https://bbbbbbbbbbbbbbbbbbbb.supabase.co', 'staging', 'https://unreviewed.pages.dev'],
  ]) assert.throws(() => deploymentOrigins(url, env, origin));
});

test('MCP production startup preserves the primary and legacy browser origins', () => {
  const result = deploymentOrigins('https://aaaaaaaaaaaaaaaaaaaa.supabase.co');
  assert.equal(result.allowedOrigin, 'https://packpilot.example');
  assert.ok(result.allowedOrigins.includes('https://legacy.packpilot.example'));
  assert.ok(result.allowedOrigins.includes('https://packpilot-site.pages.dev'));
});
