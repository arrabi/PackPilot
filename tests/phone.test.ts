import {test} from 'node:test';
import assert from 'node:assert/strict';
import {formatPhoneNumber,phoneLink} from '../auth-ui/phone.ts';
import {displayChange} from '../auth-ui/history-view.ts';
import {scoutValueHistory} from '../auth-ui/attribution.ts';
import {emptyData} from '../auth-ui/portal-model.ts';

test('phone display formats US numbers, country prefixes, extensions and international numbers',()=>{
 for(const input of ['4255552435','425-555-2435','+14255552435','1 (425) 555-2435'])assert.equal(formatPhoneNumber(input),'(425) 555-2435');
 assert.equal(formatPhoneNumber('4255552435 ext 42'),'(425) 555-2435 ext. 42');
 assert.equal(formatPhoneNumber('+442079460018'),'+44 20 7946 0018');
 assert.equal(formatPhoneNumber(null),'');
 assert.equal(formatPhoneNumber('425'),'425');
 assert.match(phoneLink('4255552435'),/href="tel:\+14255552435"/);
 assert.ok(phoneLink('4255552435').includes('(425) 555-2435'));
 assert.equal(phoneLink('<script>alert(1)</script>'),'&lt;script&gt;alert(1)&lt;/script&gt;');
});
test('phone numbers are formatted in change history and recorded values without altering stored records',()=>{
 const data:any={scouts:[],adventures:[],events:[],jobs:[]};
 assert.equal(displayChange('4255552435','parent_1_phone',data),'(425) 555-2435');
 assert.equal(displayChange('4255552435','bsa_member_id',data),'4255552435');
 const scout={id:'one',scout_name:'Sample',den:'0-Lions',parent_1_phone:'4255552435'};
 assert.match(scoutValueHistory({...emptyData(),scouts:[scout]},scout),/\(425\) 555-2435/);
 assert.equal(scout.parent_1_phone,'4255552435');
});
