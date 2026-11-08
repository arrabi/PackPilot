import {todayLA} from './portal-model.ts';
import type {FamilyMessage} from './family-model.ts';

const hour=60*60*1000,day=24*hour;
function validDate(value:string){
 if(!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;
 const date=new Date(value+'T00:00:00Z');
 return Number.isFinite(date.getTime())&&date.toISOString().slice(0,10)===value;
}
function instant(value:string|null|undefined){
 if(!value||!validDate(value.slice(0,10))||!/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value))return NaN;
 return Date.parse(value);
}
export function isNewFamilyItem(createdAt:string|null|undefined,now=new Date()){
 const age=now.getTime()-instant(createdAt);
 return age>=0&&age<48*hour;
}
export function familyDeadlineLabel(deadline:string|null|undefined,now=new Date()):'Due soon'|'Overdue'|null{
 if(!deadline)return null;
 if(validDate(deadline)){
  const days=(Date.parse(deadline+'T00:00:00Z')-Date.parse(todayLA(now)+'T00:00:00Z'))/day;
  return days<0?'Overdue':days<=3?'Due soon':null;
 }
 const remaining=instant(deadline)-now.getTime();
 return !Number.isFinite(remaining)?null:remaining<0?'Overdue':remaining<=3*day?'Due soon':null;
}
export function familyMessageAttention(data:{scouts:{id:string}[];familyMessages?:FamilyMessage[]}){
 const ids=new Set(data.scouts.map(s=>s.id));
 const unread=(data.familyMessages||[]).filter(m=>ids.has(m.scout_id)&&m.unread&&!m.is_mine);
 return {unreadMessages:unread.length,messageChild:unread[0]?.scout_id};
}
