import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {adventureBadgeUrl} from '../auth-ui/adventure-badges.ts';
import {badgeArt} from '../auth-ui/badge-art.ts';
import type {Adventure} from '../auth-ui/portal-model.ts';

test('official badge URLs use name and rank across installations and unknown content has no external image',async()=>{
 const lion=adventureBadgeUrl({name:'Bobcat',rank:'lion'}),tiger=adventureBadgeUrl({name:'Bobcat',rank:'tiger'});
 assert.match(lion,/^https:\/\/www\.scouting\.org\/wp-content\/uploads\//);
 assert.notEqual(lion,tiger);
 assert.equal(adventureBadgeUrl({name:' BOBcat ',rank:' LION '}),lion);
 assert.equal(adventureBadgeUrl({name:'Sample Adventure 1',rank:'lion'}),'');
 assert.equal(adventureBadgeUrl({name:'Bobcat'}),'');
 const markup=badgeArt({id:'new-instance-id',name:'Bobcat',rank:'lion'} as Adventure);
 assert.ok(markup.includes(lion));assert.match(markup,/referrerpolicy="no-referrer"/);
 assert.doesNotMatch(markup,/onerror=|\/badges\//);
 const headers=await readFile(new URL('../auth-ui/public/_headers',import.meta.url),'utf8');
 assert.match(headers,/img-src 'self' data: https:\/\/www\.scouting\.org;/);
});
