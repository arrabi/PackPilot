import {familyDeadlineLabel,isNewFamilyItem} from './family-attention.ts';
import {badgeArt} from './badge-art.ts';
import{escapeHtml as h,todayLA,dateLabel}from'./portal-model.ts';
import{parentTaskLink,appLink}from'./app-shell.ts';
import{eventWhen,parentItemLink}from'./workspace-model.ts';
import{icon}from'./icons.ts';
import type{ParentData}from'./parents-ui.ts';
export const registrationLinks={national:'https://example.test/national-registration',active:'https://example.test/pack-registration',guide:'https://example.test/registration-guide'};
function badge(label:string,state='neutral',symbol='clock'){return`<span class="hub-status hub-status-${state}">${icon(symbol)}${h(label)}</span>`;}
function task(type:string,symbol:string,label:string,scout:string,status:string,title:string,body:string,actions:string,attributes=''){
 return`<article class="task-card hub-task hub-${type}" ${attributes}><div class="hub-card-top"><span class="hub-icon">${icon(symbol)}</span><div class="hub-card-label"><span>${h(label)}</span><strong>${h(scout)}</strong></div><div class="hub-badges">${status}</div></div><h3>${h(title)}</h3><p>${body}</p><div class="hub-actions">${actions}</div></article>`;
}
function attention(createdAt:string|null|undefined,deadline:string|null|undefined,now:Date){
 const due=familyDeadlineLabel(deadline,now);
 return (isNewFamilyItem(createdAt,now)?badge('New','new','sparkle'):'')+(due?badge(due,due==='Overdue'?'overdue':'due',due==='Overdue'?'alert':'clock'):'');
}
export function familyDashboard(data:ParentData,year:string,preview=false,guided=false,now=new Date()){
 const today=todayLA(now);
 const cards:string[]=[];let waiting=0;
 for(const s of data.scouts){
  const name=s.scout_name||'Your scout';
  if(data.scout_photos&&!data.scout_photos.some(p=>p.scout_id===s.id))cards.push(task('photo','photo','Scout photo',name,badge('Add a photo','neutral','photo'),'A familiar face for your den',`Help den leaders recognize ${h(name)} with a clear scout portrait.`,preview?'<span>Read-only preview</span>':`<a class="button primary" href="${h(appLink('/images?scout_id='+encodeURIComponent(s.id)+'#photo-'+encodeURIComponent(s.id),'parent',{year,den:s.den||''}))}">Upload scout photo</a>`,`data-photo-task="${h(s.id)}"`));
  for(const a of(data.assignments||[]).filter(a=>a.scout_id===s.id&&['todo','returned'].includes(a.status))){
   const adventure=data.adventures.find(v=>v.id===a.adventure_id);
   cards.push(task('homework','book','Homework',name,badge(a.status==='returned'?'Try again together':'To do','warm','book')+attention(a.created_at,a.due_on,now),`${adventure?.name||'Adventure'} · Requirement ${a.requirement_code}`,`${guided&&adventure?badgeArt(adventure):''}A little time together goes a long way.${a.due_on?`<span class="hub-due">${icon('calendar')}Due ${h(dateLabel(a.due_on))}</span>`:''}`,`<a class="button primary" href="${h(parentTaskLink(s.id,'homework','assignment-'+a.id))}">Open homework</a>`));
  }
  waiting+=(data.assignments||[]).filter(a=>a.scout_id===s.id&&a.status==='submitted').length;
  const unread=(data.familyMessages||[]).filter(m=>m.scout_id===s.id&&m.unread&&!m.is_mine);
  if(unread.length)cards.push(task('message','message','Messages',name,badge(`${unread.length} unread`,'info','message')+attention(unread.find(m=>isNewFamilyItem(m.recorded_at,now))?.recorded_at,null,now),'A note from your den leaders','Read your conversation and keep in touch.',`<a class="button primary" href="${h(parentTaskLink(s.id,'messages','message-'+unread[0].id))}">Read messages</a>`));
  for(const platform of['scouting.org','active.com']){
   const reg=data.registrations.find(r=>r.scout_id===s.id&&r.platform===platform);if(reg?.status==='confirmed')continue;
   const report=data.registration_reports?.find(r=>r.scout_id===s.id&&r.platform===platform&&r.scouting_year===year),national=platform==='scouting.org';
   cards.push(task(national?'registration':'active',national?'shield':'ticket',national?'National registration':'Active.com',name,badge(report?'Awaiting verification':'Needs verification','info','clock'),'Confirm your registration',report?'Your request is with your leader. We’ll update this when it is verified.':'Already signed up? Let your leader know.',`<a class="button primary" href="${national?registrationLinks.national:registrationLinks.active}" target="_blank" rel="noopener noreferrer">Open registration</a><div class="hub-secondary-actions">${national?`<a href="${registrationLinks.guide}" target="_blank" rel="noopener noreferrer">Registration guide</a>`:''}${!report&&!preview?`<button class="text-button" data-registration-report data-scout="${h(s.id)}" data-platform="${platform}">Request verification</button>`:''}</div>`));
  }
 }
 const p=data.participation,allEvents=(p?.events||[]).filter(e=>!e.cancelled&&(e.end_date||e.event_date)>=today).sort((a,b)=>a.event_date.localeCompare(b.event_date)),events=allEvents.slice(0,4),commitments=(p?.jobs||[]).filter(j=>(j.mine||j.family_commitment_count||j.on_waitlist)&&!p?.events.find(e=>e.id===j.event_id)?.cancelled&&(!j.signup_date||j.signup_date>=today));
 // Pending RSVPs and available volunteer roles are actionable reminders, alongside homework.
 for(const e of allEvents){
  const responded=p!.bookings.some(b=>b.event_id===e.id)||p?.responses?.some(r=>r.event_id===e.id);
  if(e.rsvp_mode==='none'||responded||!familyDeadlineLabel(e.rsvp_deadline,now))continue;
  cards.push(task('event','calendar','Event RSVP','Your family',badge('Response needed','warm','calendar')+attention(e.created_at,e.rsvp_deadline,now),e.title,`Let your den leaders know if your family is coming.${e.rsvp_deadline?`<span class="hub-due">${icon('clock')}RSVP by ${h(new Intl.DateTimeFormat('en-US',{dateStyle:'medium',timeStyle:'short',timeZone:e.timezone||'America/Los_Angeles'}).format(new Date(e.rsvp_deadline)))}</span>`:''}`,preview?'<span>Read-only preview</span>':`<a class="button primary" href="${h(parentItemLink('event',e.id))}">View event / respond</a>`));
 }
 for(const j of p?.jobs||[]){
  const group=p?.signups?.find(g=>g.id===j.signup_id),event=p?.events.find(e=>e.id===j.event_id);
  if(j.closed||group?.closed||event?.cancelled||j.mine||j.family_commitment_count||j.on_waitlist||j.capacity!==null&&j.used>=j.capacity)continue;
  if(event&&(event.end_date||event.event_date)<today||!event&&j.signup_date&&j.signup_date<today)continue;
  const deadline=[j.signup_date,group?.signup_date,event?.event_date].filter((d):d is string=>!!d).sort()[0];
  cards.push(task('volunteer','people','Volunteer opportunity',group?.title||'PackPilot',badge('A way to help','success','people')+attention(j.created_at||group?.created_at,deadline,now),j.title,`${h(j.details||group?.details||'Choose a way to help that works for your family.')}${deadline?`<span class="hub-due">${icon('calendar')}Needed by ${h(dateLabel(deadline))}</span>`:''}`,preview?'<span>Read-only preview</span>':`<a class="button primary" href="${h(parentItemLink('job',j.id))}">View volunteer role</a>`));
 }
 return`<section class="family-action-center" aria-labelledby="family-actions"><div class="hub-section-heading"><h2 id="family-actions">Your family's next steps</h2><span class="hub-count">${cards.length?cards.length+' to do':'All caught up'}</span></div>${waiting?`<p class="hub-review-note" role="status">${icon('clock')}${waiting} homework submission${waiting===1?'':'s'} awaiting leader review</p>`:''}${!cards.length?`<p class="hub-caught-up">${icon('check')}You’re caught up. Thank you for helping your scout grow!</p>`:''}<div class="task-grid hub-grid">${cards.join('')}</div></section>
 <section class="hub-events"><div class="hub-section-heading"><h2>${icon('calendar')}Upcoming events</h2></div><div class="task-grid hub-grid">${events.map(e=>{
  const bookings=p!.bookings.filter(b=>b.event_id===e.id),declined=p?.responses?.some(r=>r.event_id===e.id&&r.response==='not_going');
  const date=new Date(e.event_date+'T12:00:00Z'),month=new Intl.DateTimeFormat('en-US',{month:'short',timeZone:'UTC'}).format(date),day=e.event_date.slice(8).replace(/^0/,'');
  return`<article class="task-card hub-event"><div class="hub-event-top"><time class="hub-date" datetime="${h(e.event_date)}"><span>${h(month)}</span><strong>${h(day)}</strong></time><div class="hub-event-info"><h3>${h(e.title)}</h3><p>${icon('clock')}${h(eventWhen(e))}</p>${e.location?`<p>${icon('pin')}${h(e.location)}</p>`:''}</div></div>${badge(bookings.length?`Going · ${bookings.length} scout${bookings.length===1?'':'s'}`:declined?'Not going':e.rsvp_mode==='none'?'No RSVP needed':'RSVP needed',bookings.length?'success':!declined&&e.rsvp_mode!=='none'?'warm':'neutral',bookings.length?'check':!declined&&e.rsvp_mode!=='none'?'alert':'calendar')}${attention(e.created_at,!bookings.length&&!declined&&e.rsvp_mode!=='none'?e.rsvp_deadline:null,now)}<div class="hub-actions">${preview?'<span>Read-only preview</span>':`<a class="button secondary" href="${h(parentItemLink('event',e.id))}">${bookings.length?'View your RSVP':e.rsvp_mode==='none'?'View event':'View event / respond'}</a>`}</div></article>`;
 }).join('')||'<p>No upcoming events have been added for your family yet.</p>'}</div></section>
 <section class="hub-commitments"><div class="hub-section-heading"><h2>${icon('people')}Your volunteer commitments</h2></div><div class="task-grid hub-grid">${commitments.map(j=>task('volunteer','people','Volunteering',p?.signups?.find(g=>g.id===j.signup_id)?.title||'PackPilot',badge(j.on_waitlist&&!j.mine&&!j.family_commitment_count?'On the waitlist':'You’re helping','success','people')+attention(j.created_at,p?.events.find(e=>e.id===j.event_id)?.event_date||j.signup_date,now),j.title,`${j.mine?'You have a place.':j.family_commitment_count?j.family_commitment_count+' parent(s) in your family have a place.':'You will be signed up automatically if a place opens.'}${j.my_note?`<span class="hub-due">Your note: ${h(j.my_note)}</span>`:''}`,preview?'<span>Read-only preview</span>':`<a class="button secondary" href="${h(parentItemLink('job',j.id))}">View or update commitment</a>`)).join('')||'<p>No commitments yet. Open Events to find a way to help that works for your family.</p>'}</div></section>`;
}
