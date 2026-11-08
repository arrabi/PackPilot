import{escapeHtml as h,denRank,todayLA}from'./portal-model.ts';
import{type CommunityData,type CommunityEvent,type Meeting}from'./community-model.ts';
export type WorkspaceView='events'|'calendar'|'images'|'planner'|'notes'|'history'|'admin'|'data-export';
export function workspaceViewFromPath(pathname:string,hash=''):WorkspaceView {
 if(pathname.startsWith('/community'))return ({events:'events',volunteers:'events',photos:'images',meetings:'planner'} as Record<string,WorkspaceView>)[hash.replace(/^#/,'')]||'events';
 const section=pathname.replace(/^\/(?:v2|prev)(?=\/|$)/,'').replace(/^\//,'').replace(/\/$/,'').replace(/\.html$/,'');
 return ['events','calendar','images','planner','notes','history','admin','data-export'].includes(section)?section as WorkspaceView:'events';
}
export interface WorkspaceData extends CommunityData{
 unread_family_messages?:number;unread_family_message_child?:string|null;
 is_admin:boolean;user_id:string;identity?:string;default_den?:string|null;year_end?:string;
 activities?:{id:string;title:string;occurred_on:string;event_id?:string|null;present?:string[]}[];
 progress?:{scout_id:string;adventure_id:string;scouting_year:string;requirement_code:string;completed_on:string}[];
 advancement?:{scout_id:string;adventure_id:string;scouting_year:string;earned_on:string|null;badge_delivered_on:string|null}[];
 priorities?:{den:string;scouting_year:string;adventure_ids:string[];revision:number}[];
 notes?:{id:string;den:string;owner_id:string;owner_name?:string;body:string;revision:number;recorded_at:string}[];
}
export const eventTypes:Record<string,string>={event:'Event',pack_meeting:'Pack meeting',den_meeting:'Den meeting',outing:'Outing',pack_activity:'Pack activity'};
export function safeParentReturn(value:string|null,origin='https://packpilot.example'):string|null{
 if(!value||!value.startsWith('/')||value.startsWith('//')||/[\\\r\n]/.test(value))return null;
 try{const url=new URL(value,origin);if(url.origin!==origin||!['/events','/calendar','/images','/data-export','/community'].includes(url.pathname.replace(/^\/(?:v2|prev)(?=\/|$)/,'').replace(/\/$/,'')||'/'))return null;url.searchParams.set('parent','1');return url.pathname+url.search+url.hash;}catch{return null;}
}
export function parentItemLink(kind:'event'|'job'|'signup',id:string,origin='https://packpilot.example'){const url=new URL('/events',origin);url.searchParams.set('parent','1');url.searchParams.set(kind,id);return url.href;}
export interface CalendarItem{id:string;date:string;title:string;type:string;kind:'event'|'job'|'signup';cancelled?:boolean;}
export function calendarItems(data:Pick<CommunityData,'events'|'jobs'|'signups'>):{dated:CalendarItem[];undated:CalendarItem[]}{
 const dated:CalendarItem[]=[];for(const e of data.events){let date=e.event_date;for(let n=0;n<366&&date<=(e.end_date||e.event_date);n++){dated.push({id:e.id,date,title:e.title,type:e.event_type||'event',kind:'event',cancelled:e.cancelled});const next=new Date(date+'T12:00:00Z');next.setUTCDate(next.getUTCDate()+1);date=next.toISOString().slice(0,10);}}const undated:CalendarItem[]=[];
 for(const signup of data.signups||[]){const event=data.events.find(e=>e.id===signup.event_id),roles=data.jobs.filter(j=>j.signup_id===signup.id);const item:CalendarItem={id:signup.id,date:event?.event_date||signup.signup_date||'',title:signup.title,type:'volunteer',kind:'signup',cancelled:signup.closed||event?.cancelled||roles.length>0&&roles.every(j=>j.closed)};if(item.date)dated.push(item);else undated.push(item);}
 for(const job of data.jobs){if(data.signups?.some(s=>s.id===job.signup_id))continue;const event=data.events.find(e=>e.id===job.event_id);const item:CalendarItem={id:job.id,date:event?.event_date||job.signup_date||'',title:job.title,type:'volunteer',kind:'job',cancelled:job.closed||event?.cancelled};if(item.date)dated.push(item);else undated.push(item);}
 return{dated,undated};
}
export function monthGrid(month:string){if(!/^\d{4}-\d{2}$/.test(month))throw Error('Choose a month');const[y,m]=month.split('-').map(Number);if(m<1||m>12)throw Error('Choose a month');const start=new Date(Date.UTC(y,m-1,1));const first=new Date(start);first.setUTCDate(1-first.getUTCDay());return Array.from({length:42},(_,i)=>{const d=new Date(first);d.setUTCDate(d.getUTCDate()+i);const date=d.toISOString().slice(0,10);return{date,day:d.getUTCDate(),inMonth:date.startsWith(month)};});}
export function shiftMonth(month:string,step:number){const[y,m]=month.split('-').map(Number);return new Date(Date.UTC(y,m-1+step,1)).toISOString().slice(0,7);}
export function currentWeek(today=todayLA()){const d=new Date(today+'T12:00:00Z');d.setUTCDate(d.getUTCDate()-d.getUTCDay());const first=d.toISOString().slice(0,10);d.setUTCDate(d.getUTCDate()+6);return{first,last:d.toISOString().slice(0,10)};}
export function eventWhen(e:CommunityEvent){const date=new Intl.DateTimeFormat('en-US',{weekday:'short',month:'short',day:'numeric',year:'numeric',timeZone:'UTC'}).format(new Date(e.event_date+'T12:00:00Z'));const time=(t:string)=>{const[hour,minute]=t.split(':').map(Number);return`${hour%12||12}:${String(minute).padStart(2,'0')} ${hour<12?'AM':'PM'}`;};return date+(e.start_time?' · '+time(e.start_time):' · All day')+(e.end_date&&e.end_date!==e.event_date?' – '+e.end_date:'')+(e.end_time?' – '+time(e.end_time):'')+(e.start_time?' ('+(e.timezone||'America/Los_Angeles')+')':'');}
export function renderCalendar(data:CommunityData,month:string,parent:boolean,selectedDay=''){
 const items=calendarItems(data),today=todayLA(),week=currentWeek(today),cells=monthGrid(month);const path=(i:CalendarItem)=>'/events?'+(parent?'parent=1&':'')+i.kind+'='+encodeURIComponent(i.id);
 const weeks=Array.from({length:6},(_,i)=>cells.slice(i*7,i*7+7));
 return`<section class="calendar-panel"><div class="month-toolbar"><button data-month="${shiftMonth(month,-1)}" aria-label="Previous month">←</button><h2>${h(new Intl.DateTimeFormat('en-US',{month:'long',year:'numeric',timeZone:'UTC'}).format(new Date(month+'-01T12:00:00Z')))}</h2><button data-month="${shiftMonth(month,1)}" aria-label="Next month">→</button><button data-month="${today.slice(0,7)}" data-today>Today</button></div><p class="calendar-key"><span class="today-key">Today</span> <span class="week-key">Current week</span> · Select a day to see its events below.</p><div class="calendar-legend">${Object.entries({...eventTypes,volunteer:'Volunteer signup'}).map(([k,v])=>`<span class="calendar-item type-${k}">${h(v)}</span>`).join('')}</div><div class="month-grid" role="table" aria-label="Monthly events"><div class="calendar-week" role="row">${['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map(d=>`<div class="weekday" role="columnheader">${d}</div>`).join('')}</div>${weeks.map(days=>`<div class="calendar-week ${days.some(d=>d.date>=week.first&&d.date<=week.last)?'current-week-row':''}" role="row">${days.map(day=>{const entries=items.dated.filter(i=>i.date===day.date);return`<div class="day-cell ${day.inMonth?'':'outside'} ${day.date>=week.first&&day.date<=week.last?'current-week':''} ${day.date===today?'today':''} ${day.date===selectedDay?'selected-day':''}" role="cell"><button class="calendar-day" data-day="${day.date}" aria-label="${day.date}${day.date===today?', today':''}, ${entries.length} event(s)" ${day.date===today?'aria-current="date"':''} aria-pressed="${day.date===selectedDay}"><time datetime="${day.date}">${day.day}</time></button>${entries.map(i=>`<a class="calendar-item type-${h(i.type)} ${i.cancelled?'cancelled':''}" href="${h(path(i))}">${h(i.title)}${i.cancelled?' · Closed/cancelled':''}</a>`).join('')}</div>`;}).join('')}</div>`).join('')}</div>${items.undated.length?`<details><summary>Undated volunteer opportunities · ${items.undated.length}</summary><ul>${items.undated.map(i=>`<li><a href="${h(path(i))}">${h(i.title)}</a></li>`).join('')}</ul></details>`:''}</section>`;
}
export function plannerCoverage(data:WorkspaceData,den:string,year:string){
 const scouts=data.scouts.filter(s=>s.den===den),priorities=data.priorities?.find(p=>p.den===den&&p.scouting_year===year)?.adventure_ids||[];
 const adventures=data.adventures.filter(a=>a.rank===denRank(den)&&(a.catalog_context?.adventure_type==='Required (Core)'||priorities.includes(a.id)));
 return adventures.map(a=>({adventure:a,scouts:scouts.map(s=>{
  const earned=!!data.advancement?.some(v=>v.scout_id===s.id&&v.adventure_id===a.id&&v.scouting_year===year&&v.earned_on);
  const requirements=a.requirements.map(r=>({code:r.code,description:r.description,completed:earned||!!data.progress?.some(p=>p.scout_id===s.id&&p.adventure_id===a.id&&p.scouting_year===year&&p.requirement_code===r.code),planned:data.meetings.filter(m=>m.den===den&&m.meeting_date>=todayLA()&&m.meeting_date>=year.slice(0,4)+'-07-01'&&m.meeting_date<=(data.year_end||`${Number(year.slice(0,4))+1}-06-30`)&&m.requirements.some(q=>q.adventure_id===a.id&&q.code===r.code)).map(m=>m.meeting_date)}));
  const rules=Array.isArray(a.completion_groups)&&a.completion_groups.length?a.completion_groups as{minimum:number;codes:string[]}[]:a.requirements.map(r=>({minimum:1,codes:[r.code]}));
  const groups=rules.map(g=>{const rows=requirements.filter(r=>g.codes.includes(r.code)),completed=rows.filter(r=>r.completed).length,covered=rows.filter(r=>r.completed||r.planned.length).length;return{...g,completed,covered,missing:Math.max(0,g.minimum-covered)};});
  return{scout:s,earned,groups,requirements:requirements.map(r=>({...r,alternative:!r.completed&&!r.planned.length&&groups.some(g=>g.codes.includes(r.code))&&groups.filter(g=>g.codes.includes(r.code)).every(g=>g.covered>=g.minimum)}))};
 })}));
}
