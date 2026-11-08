import {backLabel} from './back-navigation.ts';
import {familyMessageAttention} from './family-attention.ts';
import {icon} from './icons.ts';
import {returnHomeAfterScenario,takeScenarioNotice} from './scenario-navigation.ts';
import {isV2,decorateV2,decoratePrevious,installV2Review} from './v2-shell.ts';
import {badgeArt} from './badge-art.ts';
import{familyDashboard}from'./family-dashboard.ts';
import{accountBar,appFooter,appLink,captureView,clearContext,helpPanel,readContext,renderNavigation,restoreView,saveContext}from'./app-shell.ts';
import {valueAttribution,type Attribution} from './attribution.ts';
import {parentFamilyPanel,type FamilyDraft}from "./parent-family.ts";
import type {FamilyWork}from "./family-model.ts";
import { compareAdventures, dateLabel, denName, denRank, escapeHtml as h, safeSource, type Adventure, type Scout, type Progress, type Advancement, type Registration } from './portal-model.ts';
import {canonicalParentEmail} from './parents-auth.ts';
const logo = new URL('../resources/packpilot-logo.svg', import.meta.url).href;
export interface ParentData extends Partial<FamilyWork> { attribution?:Attribution[];scout_photos?:{scout_id:string}[];preview_scope?:string;participation?:import('./workspace-model.ts').WorkspaceData;registration_reports?:{scout_id:string;scouting_year:string;platform:string;reported_at:string}[]; scouts: Pick<Scout,'id'|'scout_name'|'den'|'grade'|'bsa_member_id'>[]; adventures: Adventure[]; advancement: Pick<Advancement,'scout_id'|'adventure_id'|'earned_on'|'badge_delivered_on'|'badge_form'>[]; progress: Progress[]; registrations: Pick<Registration,'scout_id'|'platform'|'status'|'occurred_on'>[]; }
export interface ParentService {
 identity(): Promise<{email:string}|null>;
 requestCode(email:string,remember:boolean):Promise<void>;
 verifyCode(email:string,code:string):Promise<void>;
 load():Promise<ParentData>;
 signOut():Promise<void>;reportRegistration?(request_id:string,command:Record<string,unknown>):Promise<void>;
 saveFamily?(entries:{request_id:string;command:Record<string,unknown>}[]):Promise<void>;
 onSignOut?(callback:()=>void):()=>void;
 preview?:boolean;
 emailReady?:boolean;
 remember?:boolean;
}
export function mountParents(root:HTMLElement,service:ParentService) {
 const v2=isV2(root.ownerDocument.defaultView!);const removeReview=v2?installV2Review(root):()=>{};
 const win=root.ownerDocument.defaultView!;
 let mode:'loading'|'email'|'code'|'family'='loading',email='',signedEmail='',error='',notice=v2?takeScenarioNotice(win,'parent'):'',busy=false,remember=service.remember!==false;
 let family:ParentData|null=null,childId='',filter='all',generation=0,disposed=false,resendAfter=0;
 const context=readContext(win,service.preview?'leader':'parent'),year=context.year;let section=new URL(win.location.href).searchParams.get('section')||'home';
 let lastFamilyCheck=Date.now(),checkingFamily=false,lastAttentionMinute=Math.floor(Date.now()/60000);
 const drafts=new Map<string,FamilyDraft>();
 let pendingWrite:{entries:{request_id:string;command:Record<string,unknown>}[];label:string;draftKey:string;registration?:boolean}|null=null;
 const writeDisabled=()=>busy||!!pendingWrite||!!service.preview||!service.saveFamily;
 const message=(value:string)=>`<div class="parent-message" role="status">${h(value)}</div>`;
 const child=(s:Scout)=>{
  const adventures=family!.adventures.filter(a=>a.rank===denRank(s.den));
  const required=adventures.filter(a=>a.catalog_context?.adventure_type==='Required (Core)');
  const earned=(a:Adventure)=>family!.advancement.find(v=>v.scout_id===s.id&&v.adventure_id===a.id)?.earned_on;
  const n=required.filter(earned).length;
  const todos=(family!.assignments||[]).filter(a=>a.scout_id===s.id&&['todo','returned'].includes(a.status)).length,unread=(family!.familyMessages||[]).filter(m=>m.scout_id===s.id&&m.unread).length;
  return `<button class="parent-child ${childId===s.id?'is-current':''}" data-child="${h(s.id)}" ${childId===s.id?'aria-pressed="true"':'aria-pressed="false"'}><span class="parent-avatar" aria-hidden="true">${h((s.scout_name||'?').split(/\s+/).map(s=>s[0]).slice(0,2).join(''))}</span><span><strong>${h(s.scout_name)}</strong><small>${h(denName(s.den))} · ${required.length ? `${n}/${required.length} required adventures earned` : "Adventure catalog not available"}</small>${todos||unread?`<small><strong>${todos} home tasks · ${unread} unread messages</strong></small>`:""}<progress value="${n}" max="${Math.max(1,required.length)}" aria-label="${h(s.scout_name)}: ${n} of ${required.length} required adventures earned"></progress></span><span aria-hidden="true">→</span></button>`;
 };
 function progressView(s:Scout) {
  const all=family!.adventures.filter(a=>a.rank===denRank(s.den)).sort(compareAdventures);
  const earned=family!.advancement.filter(a=>a.scout_id===s.id&&a.earned_on),waiting=earned.filter(a=>!a.badge_delivered_on);
  const list=all.filter(a=>filter==='all'||(filter==='required'?a.catalog_context?.adventure_type==='Required (Core)':a.catalog_context?.adventure_type==='Elective'));
  return `${parentFamilyPanel(family!,family!.adventures,s.id,s.scout_name||"your child",writeDisabled(),!!service.preview,drafts)}<section class="parent-progress" aria-labelledby="child-title"><div class="parent-section-title"><div><p class="eyebrow">${h(denName(s.den))} · ${year}</p><h2 id="child-title">${h(s.scout_name)}’s adventures</h2></div></div><div class="parent-totals"><div><strong>${earned.length}</strong><span>Adventures earned</span></div><div><strong>${waiting.length}</strong><span>Badges awaiting handout</span></div></div><div class="parent-child-details"><span>BSA number: <strong>${h(s.bsa_member_id||'Not recorded')}</strong></span>${['active.com','scouting.org'].map(p=>{const r=family!.registrations.find(r=>r.scout_id===s.id&&r.platform===p);return `<span>${p==='active.com'?'Active.com':'Scouting.org'}: <strong>${r?.status==='confirmed'?'Verified':r?.status==='not_registered'?'Not registered':'Needs verification'}</strong></span>`;}).join('')}</div><label class="parent-filter">Show adventures<select id="parent-adventure-filter"><option value="all" ${filter==='all'?'selected':''}>All adventures</option><option value="required" ${filter==='required'?'selected':''}>Required adventures</option><option value="elective" ${filter==='elective'?'selected':''}>Elective adventures</option></select></label><p class="parent-note">These are your child’s recorded achievements for ${year}. Missing history means not recorded. Your den leader records and confirms completions.</p><div class="parent-adventures">${list.map(a=>{
   const state=family!.advancement.find(v=>v.scout_id===s.id&&v.adventure_id===a.id);
   const progress=family!.progress.filter(p=>p.scout_id===s.id&&p.adventure_id===a.id);
   const count=state?.earned_on?a.requirements.length:a.requirements.filter(r=>progress.some(p=>p.requirement_code===r.code)).length;
   return `<details class="parent-adventure" id="adventure-${h(a.id)}"><summary><span>${badgeArt(a)}<small>${a.catalog_context?.adventure_type==='Required (Core)'?'Required':a.catalog_context?.adventure_type==='Elective'?'Elective':'Adventure'}</small><strong>${h(a.name)}</strong><small>${count}/${a.requirements.length} requirements recorded</small></span><span class="parent-status ${state?.earned_on?'complete':''}">${state?.badge_delivered_on?'Badge received':state?.earned_on?'Earned':count?'In progress':'Not recorded'}</span></summary><div class="parent-adventure-body">${state?.earned_on?`<p><strong>Earned:</strong> ${h(dateLabel(state.earned_on))}${valueAttribution(family!.attribution,"pack_advancement",{scout_id:s.id,adventure_id:a.id,scouting_year:year},"earned_on")}</p>`:''}${state?.badge_delivered_on?`<p><strong>Badge received:</strong> ${h(dateLabel(state.badge_delivered_on))}${valueAttribution(family!.attribution,"pack_advancement",{scout_id:s.id,adventure_id:a.id,scouting_year:year},"badge_delivered_on")}</p>`:state?.earned_on?'<p>Physical badge awaiting handout.</p>':''}<ol>${a.requirements.map(r=>{const p=progress.find(p=>p.requirement_code===r.code);return `<li><p>${h(r.description)}</p><small>${p?`Completed ${h(dateLabel(p.completed_on))}`:state?.earned_on?`Completed with adventure earned ${h(dateLabel(state.earned_on))}`:'Not recorded'}</small>${p?valueAttribution(family!.attribution,'pack_requirement_progress',{scout_id:s.id,adventure_id:a.id,requirement_code:r.code,scouting_year:year},'completed_on'):''}</li>`;}).join('')}</ol>${a.readiness_mode==='leader_review'?'<p class="parent-note">This adventure includes completion options that your den leader reviews.</p>':''}<a href="${h(safeSource(a.source_url))}" target="_blank" rel="noopener noreferrer">Official adventure requirements →</a></div></details>`;
  }).join('')||'<p class="parent-note">No adventures available for this view. Your den leader can help check the records.</p>'}</div></section>`;
 }
 function moreView(){return `${service.preview?'<p>Photos and data exports require the actual parent’s account. This preview remains read only.</p>':`<section class="task-grid"><a class="button secondary" href="${h(appLink('/images','parent',{year}))}">Scout and family photos</a></section>`}${helpPanel('parent')}${!service.preview?`<details class="parent-advanced" data-state-key="parent-advanced"><summary>Advanced</summary><p><a href="${h(appLink('/data-export','parent',{year}))}">export all scout info</a></p></details>`:''}`;}
 function render() {
  if(disposed)return;
  lastAttentionMinute=Math.floor(Date.now()/60000);
  const viewState=captureView(root);saveContext(win,service.preview?"leader":"parent",{year,den:context.den,child:childId});
  const auth=mode==='email'||mode==='code';
  root.innerHTML=`<div class="parent-shell">${service.preview?`<div class="parent-preview-banner" role="status"><strong>Admin preview · ${h(family?.preview_scope||'Selected family')}</strong><span>Live data · Read only · Family links unchanged</span></div>`:''}<header class="app-header"><a class="app-header-brand" href="${service.preview?'/parents?preview=1':'/parents'}">PACKPILOT · FAMILY HUB</a>${mode==='family'?accountBar('parent',signedEmail,!!service.preview).replace('data-app-signout','data-app-signout data-action="logout"')+renderNavigation('parent',section==='home'?'home':section==='more'?'more':section==='messages'?'messages':'progress',{year,den:'',child:childId},false,family?familyMessageAttention(family):{}):'<p><a href="/">Leader portal →</a></p>'}</header><main id="parent-main" class="${auth?'parent-auth':'parent-main'}">${error?`<div class="parent-message error" role="alert" tabindex="-1">${h(error)}</div>`:''}${notice?message(notice):''}${pendingWrite?'<div class="parent-message error" role="alert" tabindex="-1">The save was not confirmed. Retry safely before making another change.<button class="button secondary" data-action="family-retry">Retry save</button></div>':''}${mode==='family'&&!family?'<button class="button secondary" data-action="refresh">Retry loading family records</button>':''}${mode==='loading'?'<div class="parent-loading" role="status">Opening your family hub…</div>':mode==='email'&&service.preview?`<section class="panel parent-code"><p class="eyebrow">PACK ADMINISTRATOR PREVIEW</p><h1>Try the parent view</h1><p>Use your approved administrator Google login to preview the selected den or family. Email codes and SMTP are not needed for this preview.</p><a class="button primary" href="/oauth/consent?portal=1&amp;parent_preview=1&amp;return_to=${h(encodeURIComponent(win.location.pathname+win.location.search))}">Continue with Google</a></section>`:mode==='email'?`<section class="parent-welcome"><p class="eyebrow">A LITTLE CLOSER TO EVERY ADVENTURE</p><h1>Small steps.<br>Big possibilities.</h1><p>Home activities, happy milestones, and the next steps for your family—all in one place.</p></section><section class="parent-login panel"><h2>Welcome, parent.</h2><p>Use the parent email listed with PackPilot. We’ll email you a sign-in code. No Google account or password needed.</p>${service.emailReady===false?message('Email sign-in is being set up. Please check back once the pack administrator has configured the email sender.'):''}<form data-form="email"><label>Your email<input name="email" type="email" autocomplete="email" inputmode="email" value="${h(email)}" required maxlength="254" ${busy?'disabled':''}></label><label class="parent-remember"><input name="remember" type="checkbox" ${remember?'checked':''} ${busy?'disabled':''}><span><strong>Keep me signed in on this device</strong><small>Use this on your personal phone or computer. You won’t need a code every visit.</small></span></label><button class="button primary" type="submit" ${busy||service.emailReady===false?'disabled':''}>${busy?'Sending code…':'Email me a sign-in code'}</button></form><p><a href="/parents?preview=1" class="parent-admin-preview-link">Pack administrator? Open read-only preview →</a></p></section>`:mode==='code'?`<section class="panel parent-code"><p class="eyebrow">CHECK YOUR EMAIL</p><h1>Your sign-in code</h1><p>Enter the code sent to <strong>${h(email)}</strong>. It expires after 10 minutes.</p><form data-form="code"><label>Sign-in code<input id="parent-code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6,10}" minlength="6" maxlength="10" required ${busy?'disabled':''}></label><button class="button primary" type="submit" ${busy?'disabled':''}>${busy?'Checking code…':'Open my family hub'}</button></form><div class="parent-code-actions"><button class="text-button" data-action="resend" ${busy||Date.now()<resendAfter?'disabled':''}>${Date.now()<resendAfter?'Resend available in a minute':'Resend code'}</button><button type="button" class="back-button" data-action="change-email" ${busy?'disabled':''}>${backLabel("Use a different email")}</button></div></section>`:mode==='family'&&family?`<div class="parent-family-heading"><div><p class="eyebrow">YOUR FAMILY · ${year}</p><h1>${service.preview?h(family.preview_scope||'Selected family')+' · Parent view':'Your family hub'}</h1><p>${service.preview?'Switch between scouts to preview the family progress screens. Real parents see only their linked children.':'Every little achievement is part of their story.'}</p></div><button class="button secondary" data-action="refresh" ${busy?'disabled':''}>${icon('refresh')}<span>Refresh</span></button></div>${section==='home'&&family.scouts.length?familyDashboard(family,year,!!service.preview,v2):''}${section==='more'?moreView():''}${family.scouts.length?`<section aria-label="Your children" class="parent-children">${family.scouts.map(child).join('')}</section>${family.scouts.find(s=>s.id===childId)?`<details class="selected-child-record" data-state-key="child-${h(childId)}" ${section!=='home'&&section!=='more'?'open':''}><summary>${h(family.scouts.find(s=>s.id===childId)!.scout_name)} · homework, messages and progress</summary>${progressView(family.scouts.find(s=>s.id===childId)!)}</details>`:''}`:'<section class="panel parent-empty"><h2>No children linked to this email yet</h2><p>Ask the pack administrator to check the parent email and family links on your children’s roster records. You can also sign out and try another email.</p><p><a href="mailto:contact@example.test">Ask the Cubmaster to check your family links</a></p></section>'}<p class="parent-account">Signed in as ${h(signedEmail)}. ${service.preview?'This admin preview has not changed any parent–child links.':'Only children linked to your verified email appear here.'}</p>`:''}</main>${appFooter()}</div>`;
  if(v2)decorateV2(root,'parent',section==='progress'?'progress':section==='messages'?'messages':'home',{year,den:context.den,child:childId});
  if(!v2)decoratePrevious(root);
  if(service.preview){const q=new URL(win.location.href).searchParams;for(const a of root.querySelectorAll<HTMLAnchorElement>('.app-navigation a,.v2-bottom a')){const u=new URL(a.href);u.searchParams.set('preview','1');if(q.get('den'))u.searchParams.set('den',q.get('den')!);if(q.get('preview_child'))u.searchParams.set('preview_child',q.get('preview_child')!);a.href=u.href;}}
  if(family&&childId){const u=new URL(win.location.href);u.searchParams.set('year',year);u.searchParams.set('child',childId);win.history.replaceState(null,'',u);}
  restoreView(root,viewState);if(error)root.querySelector<HTMLElement>('[role=alert]')?.focus({preventScroll:true});const q=new URL(win.location.href).searchParams;const target=q.get('item')||(section==='messages'?'parent-family-messages':section==='homework'?'parent-child-work':section==='progress'?'child-title':'');if(target){const el=root.querySelector<HTMLElement>('#'+win.CSS.escape(target));if(el){for(let d=el.closest('details');d;d=d.parentElement?.closest('details')||null)d.open=true;el.setAttribute('tabindex','-1');el.classList.add('task-focus');el.scrollIntoView?.({block:'center'});}}
 }
 function clear() {clearContext(win,service.preview?'leader':'parent');generation++;pendingWrite=null;drafts.clear();family=null;childId='';signedEmail='';email='';mode='email';busy=false;notice='';error='';render();}
 async function loadFamily() {
  const token=++generation;mode='loading';family=null;error='';render();
  try {
   const identity=await service.identity();if(disposed||token!==generation)return;
   if(!identity){clear();return;}
   signedEmail=identity.email;
   const next=await service.load();if(disposed||token!==generation)return;
   for(const key of drafts.keys()){if(key.startsWith('message:')&&!next.scouts.some(s=>'message:'+s.id===key))drafts.delete(key);if(key.startsWith('assignment:')&&!(next.assignments||[]).some(a=>'assignment:'+a.id===key))drafts.delete(key);}
   lastFamilyCheck=Date.now();family=next;if(!next.scouts.some(s=>s.id===childId))childId=next.scouts.find(s=>s.id===(new URL(win.location.href).searchParams.get('child')||context.child))?.id||next.scouts[0]?.id||'';
   const requestedChild=new URL(win.location.href).searchParams.get('child');if(requestedChild&&!next.scouts.some(s=>s.id===requestedChild))error='The linked item is unavailable for your family. Your authorized records are shown below.';mode='family';busy=false;render();
  }catch{if(disposed||token!==generation)return;family=null;mode='family';busy=false;error=service.preview?'This preview requires your pack administrator account. Sign in to the leader portal as the administrator, then reopen this preview.':'We couldn’t load your family records. Please sign out and try again, or refresh this page.';render();}
 }
 async function send() {
  const token=++generation;busy=true;error='';notice='';render();
  try{await service.requestCode(email,remember);if(disposed||token!==generation)return;mode='code';resendAfter=Date.now()+60000;notice='Code sent. Check your inbox and spam folder.';}catch{if(disposed||token!==generation)return;error='We couldn’t send a code. Please wait a minute and try again. If this continues, contact the pack administrator.';}
  busy=false;render();root.querySelector<HTMLInputElement>('#parent-code')?.focus();
 }
 async function submit(e:Event) {
  const form=(e.target as HTMLElement).closest<HTMLFormElement>('form[data-form]');if(!form)return;e.preventDefault();if(busy)return;
  if(form.dataset.form==='parent-message'||form.dataset.form==='parent-assignment'){
   if(writeDisabled())return;
   const scout=form.dataset.scout!;if(!family?.scouts.some(s=>s.id===scout))return;
   const value=(name:string)=>(form.querySelector<HTMLInputElement|HTMLTextAreaElement>(`[name="${name}"]`)?.value||'');const assignment=form.dataset.assignment;
   const command:Record<string,unknown>=form.dataset.form==='parent-message'?{action:'send_family_message',scout_id:scout,scouting_year:year,as_role:'parent',body:value('body').trim()}:{action:'submit_assignment',scout_id:scout,scouting_year:year,assignment_id:assignment,expected_revision:Number(form.dataset.revision),completed_on:value('completed_on'),parent_note:value('parent_note').trim()};
   await saveFamily(command,form.dataset.form==='parent-message'?'Message sent.':'Submitted for leader review.',assignment?'assignment:'+assignment:'message:'+scout);return;
  }
  if(form.dataset.form==='email') {const input=form.querySelector<HTMLInputElement>('[name=email]')!;email=canonicalParentEmail(input.value);remember=form.querySelector<HTMLInputElement>('[name=remember]')!.checked;if(!input.checkValidity()||service.emailReady===false)return;await send();}
  else{const code=form.querySelector<HTMLInputElement>('[name=code]')!.value.replace(/\s/g,'');if(!/^\d{6,10}$/.test(code))return;const token=++generation;busy=true;error='';notice='';render();try{await service.verifyCode(email,code);if(disposed||token!==generation)return;await loadFamily();}catch{if(disposed||token!==generation)return;busy=false;error='That code is invalid or expired. Try again or request a new code.';render();}}
 }
 async function saveFamily(command:Record<string,unknown>,label:string,draftKey=''){
  if(writeDisabled())return;
  pendingWrite={entries:[{request_id:win.crypto.randomUUID(),command}],label,draftKey};await finishFamilySave();
 }
 async function finishFamilySave(){
  if(!pendingWrite||busy||(!service.saveFamily&&!service.reportRegistration)||service.preview)return;
  const attempt=pendingWrite,token=generation;busy=true;error='';render();
  try{if(attempt.registration)await service.reportRegistration!(attempt.entries[0].request_id,attempt.entries[0].command);else await service.saveFamily!(attempt.entries);if(disposed||token!==generation)return;pendingWrite=null;drafts.delete(attempt.draftKey);notice=attempt.label;busy=false;if(v2&&attempt.entries.every(e=>e.command.action!=='mark_family_read')){section='home';returnHomeAfterScenario(win,'parent',{year,child:childId},notice,true);win.scrollTo?.({top:0,behavior:'instant'});}await loadFamily();}
  catch(err){if(disposed||token!==generation)return;busy=false;if((err as{code?:string})?.code){pendingWrite=null;error='This update could not be accepted. Refresh the family records and review the latest status before trying again.';}else error='The connection was interrupted. Retry the same save safely.';render();}
 }
 async function click(e:Event) {
  const anchor=(e.target as HTMLElement).closest<HTMLAnchorElement>('a[href]');if(anchor&&family){const next=new URL(anchor.href);if(next.origin===win.location.origin&&['/parents','/v2/parents','/prev/parents'].includes(next.pathname.replace(/\/$/,''))){e.preventDefault();if(next.searchParams.get('child')&&!family.scouts.some(s=>s.id===next.searchParams.get('child'))){error='That item is unavailable for this family.';render();return;}win.history.pushState(null,'',next);section=next.searchParams.get('section')||'home';childId=next.searchParams.get('child')||childId;render();return;}}
  const el=(e.target as HTMLElement).closest<HTMLElement>('[data-action],[data-child],[data-registration-report],[data-app-signout]');if(!el||el.hasAttribute('disabled')||busy)return;
  if(el.hasAttribute('data-registration-report')){if(!service.preview&&!busy&&!pendingWrite&&service.reportRegistration&&family?.scouts.some(s=>s.id===el.dataset.scout)){pendingWrite={entries:[{request_id:win.crypto.randomUUID(),command:{action:'registration_report',id:el.dataset.scout,year,platform:el.dataset.platform}}],label:'Your leader has been asked to verify registration.',draftKey:'',registration:true};await finishFamilySave();}return;}
  if(el.hasAttribute('data-app-signout'))el.dataset.action='logout';
  if(el.dataset.child&&family?.scouts.some(s=>s.id===el.dataset.child)){childId=el.dataset.child;filter='all';const u=new URL(win.location.href);u.searchParams.set('child',childId);u.searchParams.delete('item');win.history.replaceState(null,'',u);render();root.querySelector<HTMLElement>('#parent-child-work')?.scrollIntoView?.({block:'nearest'});return;}
  if(el.dataset.action==='family-retry'){await finishFamilySave();return;}
  if(el.dataset.action==='family-read'){if(!writeDisabled()&&family?.scouts.some(s=>s.id===el.dataset.scout))await saveFamily({action:'mark_family_read',scout_id:el.dataset.scout,scouting_year:year,through_message_id:el.dataset.message},'Conversation marked read.');return;}
  if(el.dataset.action==='change-email'){mode='email';error='';notice='';render();}
  if(el.dataset.action==='resend'&&Date.now()>=resendAfter)await send();
  if(el.dataset.action==='refresh'){if(pendingWrite)return;if(family&&drafts.size&&!win.confirm('Discard your unsent changes and refresh?'))return;if(family)drafts.clear();await loadFamily();}
  if(el.dataset.action==='logout'){if((pendingWrite||drafts.size)&&!win.confirm('Leave without confirming your unsaved changes?'))return;busy=true;try{await service.signOut();clear();}catch{busy=false;error='Sign-out didn’t complete. Please try again.';render();}}
 }
 function change(e:Event){const input=e.target as HTMLSelectElement;if(input.id==='parent-adventure-filter'){filter=input.value;render();}}
 const popstate=()=>{if(!family)return;const q=new URL(win.location.href).searchParams;section=q.get('section')||'home';if(family.scouts.some(s=>s.id===q.get('child')))childId=q.get('child')!;render();};win.addEventListener('popstate',popstate);
 const signedOut=service.onSignOut?.(clear)||(()=>{});
 const focus=()=>{if(mode==='family'&&!busy&&!pendingWrite&&!drafts.size)void loadFamily();};
 const input=(e:Event)=>{const field=e.target as HTMLInputElement|HTMLTextAreaElement,form=field.closest<HTMLFormElement>('form');if(!form)return;const key=form.dataset.form==='parent-message'?'message:'+form.dataset.scout:form.dataset.form==='parent-assignment'?'assignment:'+form.dataset.assignment:'';if(key)drafts.set(key,{...drafts.get(key),[field.name]:field.value});};
 const unload=(e:BeforeUnloadEvent)=>{if(pendingWrite||drafts.size){e.preventDefault();e.returnValue='';}};
 root.addEventListener('input',input);win.addEventListener('beforeunload',unload);
 root.addEventListener('submit',submit);root.addEventListener('click',click);root.addEventListener('change',change);win.addEventListener('focus',focus);
 async function refreshFamilyInbox(){
  if(mode!=='family'||busy||pendingWrite||drafts.size||disposed||checkingFamily||root.ownerDocument.visibilityState==='hidden')return;
  const token=generation;lastFamilyCheck=Date.now();checkingFamily=true;
  try{const next=await service.load();if(disposed||token!==generation||busy||pendingWrite||drafts.size)return;if(JSON.stringify(next)!==JSON.stringify(family)){family=next;if(!next.scouts.some(s=>s.id===childId))childId=next.scouts.find(s=>s.id===(new URL(win.location.href).searchParams.get('child')||context.child))?.id||next.scouts[0]?.id||'';render();}}catch(err){if((err as{code?:string})?.code==='42501'&&token===generation)clear();}finally{checkingFamily=false;}
 }
 const timer=win.setInterval(()=>{if(mode==='code'&&!busy&&resendAfter&&Date.now()>=resendAfter){resendAfter=0;const resend=root.querySelector<HTMLButtonElement>('[data-action=resend]');if(resend){resend.disabled=false;resend.textContent='Resend code';}}if(Date.now()-lastFamilyCheck>=30000)void refreshFamilyInbox();if(mode==='family'&&!busy&&!pendingWrite&&!drafts.size&&!checkingFamily&&root.ownerDocument.visibilityState!=='hidden'&&Math.floor(Date.now()/60000)!==lastAttentionMinute)render();},1000);
 const ready=loadFamily();
 return {ready,dispose(){removeReview();disposed=true;generation++;family=null;root.innerHTML='';signedOut();win.removeEventListener('popstate',popstate);win.clearInterval(timer);win.removeEventListener('focus',focus);root.removeEventListener('input',input);win.removeEventListener('beforeunload',unload);drafts.clear();pendingWrite=null;root.removeEventListener('submit',submit);root.removeEventListener('click',click);root.removeEventListener('change',change);}};
}
