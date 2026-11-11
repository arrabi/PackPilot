import {test} from 'node:test';
import assert from 'node:assert/strict';
import {appFooter} from '../auth-ui/app-shell.ts';

test('footer identifies the actual version, source build, environment and immutable build date in Pacific time',()=>{
 const metadata={version:'0.1.0',commit:'1234567890abcdef1234567890abcdef12345678',builtAt:'2026-11-10T01:05:00.000Z',environment:'staging' as const};
 const footer=appFooter(metadata);
 assert.match(footer,/Staging · v0\.1\.0 · Build 1234567890ab/);
 assert.match(footer,/Nov 9, 2026/);assert.match(footer,/5:05 PM PST/);
 assert.match(footer,/datetime="2026-11-10T01:05:00.000Z"/);
 assert.match(footer,/Terms of Use/);assert.match(footer,/Help \/ contact Cubmaster/);
 assert.match(appFooter({...metadata,environment:'production'}),/Production · v0\.1\.0/);
});

test('development footer handles missing metadata and escapes version text',()=>{
 assert.match(appFooter(),/Development build/);
 const footer=appFooter({version:'<script>invalid</script>',commit:'local',builtAt:'invalid',environment:'development'});
 assert(!footer.includes('<script>'));assert.match(footer,/&lt;script&gt;/);assert.match(footer,/Build local/);assert(!footer.includes('<time'));
});
