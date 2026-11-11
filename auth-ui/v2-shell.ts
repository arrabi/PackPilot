import {backLabel} from './back-navigation.ts';
import {escapeHtml as h} from './portal-model.ts';
import type {AppContext, AppRole} from './app-shell.ts';
import {appLink} from './app-shell.ts';
export const isV2 = (win:Window) => !/^\/prev(?:\/|$)/.test(win.location.pathname);
const logo = new URL('../resources/packpilot-logo.svg',import.meta.url).href;
const routes = new Set(['/','/parents','/events','/calendar','/planner','/notes','/images','/history','/admin','/data-export']);
export function v2Path(path:string) {
 const u = new URL(path,'https://packpilot.example');
 u.pathname=u.pathname.replace(/^\/v2(?=\/|$)/,'')||'/';
 return u.pathname+u.search+u.hash;
}
export function prevPath(path:string) {
 const u=new URL(path,'https://packpilot.example');
 const route=u.pathname.replace(/\/$/,'')||'/';
 if(routes.has(route))u.pathname='/prev/'+(route==='/'?'':route.slice(1)+'/');
 return u.pathname+u.search+u.hash;
}
export function decoratePrevious(root:HTMLElement) {
 for(const a of root.querySelectorAll<HTMLAnchorElement>('a[href]')){
  const raw=a.getAttribute('href')!;
  if(raw.startsWith('/')&&!raw.startsWith('//'))a.setAttribute('href',prevPath(raw));
 }
}
export function v2Navigation(role:AppRole,active:string,context:AppContext,local=false,assistant=false) {
 const parent=role==='parent';
 const items=parent?[['home','Home','⌂','/parents'],['progress','My scouts','♙','/parents?section=progress'],['events','Events','▦','/events?parent=1'],['messages','Messages','☏','/parents?section=messages']]:[['home','Today','⌂','/#home'],['scouts','Scouts','♙','/#scouts'],['events','Events','▦','/events'],['more','More','•••','/#more']];
 const showAssistant=assistant&&!parent;
 return `<nav class="v2-bottom ${showAssistant?'has-assistant':''}" aria-label="Main navigation">${items.map(([key,label,symbol,path],i)=>`${showAssistant&&i===2?'<button type="button" class="v2-ai-action" data-action="assistant-open" aria-label="Ask AI" aria-haspopup="dialog"><span class="v2-ai-orb" aria-hidden="true">✦</span><span>Ask AI</span></button>':''}<a href="${h(local&&path.startsWith('/#')?path.slice(1):v2Path(appLink(path,role,context)))}" ${active===key?'aria-current="page"':''}><span aria-hidden="true">${symbol}</span>${label}</a>`).join('')}</nav>`;
}
export function decorateV2(root:HTMLElement,role:AppRole,active:string,context:AppContext,local=false,assistant=false) {
 // Family Hub has its own current design and five-tab navigation.
 if(role==='parent')return;
 root.classList.add('v2-interface');
 const existingHeader=root.querySelector<HTMLElement>('.workspace-shell>.app-header,.parent-shell>.app-header');
 if(existingHeader){
  const account=existingHeader.querySelector('.app-account');
  existingHeader.innerHTML=`<a class="v2-brand" href="/"><img src="${logo}" alt="PackPilot" width="40" height="40"><span>PackPilot<small>Fieldbook</small></span></a><details class="v2-context"><summary>${h(context.den?context.den.slice(2):'PackPilot')} · ${h(context.year)}</summary></details><details class="v2-settings"><summary>Account</summary></details>`;
  if(account)existingHeader.querySelector('.v2-settings')!.append(account);
  const settings=existingHeader.querySelector('.v2-settings')!;
  const filters=root.querySelector('.workspace-main>.workspace-filters');
  if(filters)existingHeader.querySelector('.v2-context')!.append(filters);
  if(active==='events'){
   const title=root.querySelector('.workspace-main>.page-heading h1');if(title)title.textContent='Events';
   const body=root.querySelector('.workspace-body'),create=body?.querySelector('.create-panel');if(body&&create)body.append(create);
   for(const heading of root.querySelectorAll('.workspace-body>section>h2'))if(heading.textContent==='Events')heading.remove();
   const redundant=root.querySelector<HTMLAnchorElement>('.workspace-body a[href^="/calendar"]');redundant?.closest('p')?.remove();
  }
 }

 root.ownerDocument.body.classList.add('v2-body');
 for(const old of root.querySelectorAll('.v2-bottom,.app-navigation,.beta-bottom-nav'))old.remove();
 root.insertAdjacentHTML('beforeend',v2Navigation(role,active,context,local,assistant));
 for(const a of root.querySelectorAll<HTMLAnchorElement>('a[href]')) {
  const raw=a.getAttribute('href')!;if(!raw.startsWith('/')||raw.startsWith('//'))continue;
  a.setAttribute('href',v2Path(raw));
 }
}

/** Review is an additional client-side step; existing validation, permissions and retry IDs remain authoritative. */
export function installV2Review(root:HTMLElement) {
 const win=root.ownerDocument.defaultView!;
 const confirmed=new WeakSet<HTMLFormElement>();
 function intercept(event:Event) {
  const form=(event.target as HTMLElement).closest<HTMLFormElement>('form[data-form],form[data-kind]');
  if(!form||!isV2(win))return;
  const kind=form.dataset.form||form.dataset.kind||'';
  if(['email','code','note'].includes(kind)||!kind||form.querySelector('fieldset[disabled]'))return;
  if(confirmed.has(form)){confirmed.delete(form);return;}
  if(!form.checkValidity()){event.preventDefault();event.stopImmediatePropagation();form.reportValidity();return;}
  event.preventDefault();event.stopImmediatePropagation();
  if(root.querySelector('.v2-review'))return;
  const rows=[...form.querySelectorAll<HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement>('[name]')].filter(input=>!input.disabled&&!['hidden','file','submit'].includes(input.type)&&(!['checkbox','radio'].includes(input.type)||(input as HTMLInputElement).checked)&&!!input.value).map(input=>{
   const label=input.closest('label');let name=label?.querySelector('strong')?.textContent||label?.textContent?.trim()||input.name.replaceAll('_',' ');
   if(input.type==='checkbox')return `<li>${h(name)}</li>`;
   if(input.tagName==='SELECT')return `<li>${h(input.name.replaceAll('_',' '))}: ${h((input as HTMLSelectElement).selectedOptions[0]?.textContent||input.value)}</li>`;
   return `<li>${h(name.slice(0,100))}: <strong>${h(input.value)}</strong></li>`;
  });
  if(form.dataset.reviewSummary){rows.splice(0,rows.length,...form.dataset.reviewSummary.split('\n').map(v=>`<li>${h(v)}</li>`));}
  const fields=new win.FormData(form);
  const action=String(fields.get(kind==='adventure'?'adventure_action':'action')||'');
  const notificationChoice=(kind==='adventure'&&['record_requirement','assign_requirement','earn_adventure','deliver_badge'].includes(action))||(kind==='single-adventure'&&['earn_adventure','deliver_badge'].includes(action));
  const context=form.querySelector('.progress-review>p')?.textContent||form.closest('.attendance-sheet')?.querySelector('h2')?.textContent||'';
  const modal=root.ownerDocument.createElement('dialog');modal.className='v2-review';
  modal.innerHTML=`<div class="v2-review-body"><p class="eyebrow">REVIEW BEFORE SAVING</p><h2>Check your changes</h2>${context?`<p><strong>${h(context)}</strong></p>`:''}<p>Only the selected records below will be submitted.</p><ul>${rows.join('')||'<li>Review the selected action and details in the form.</li>'}</ul><p>Original entries remain in history. Corrections are available from the record.</p>${notificationChoice?`<label class="v2-notification-choice"><input type="checkbox" data-notify-parents ${fields.get('notify_parents')==='false'?'':'checked'}><span><strong>Send notification(s) to parents</strong><small>Applies to all selected scouts. Saturday reminders still include pending work.</small></span></label>`:''}<div class="v2-review-actions"><button type="button" class="button primary" data-confirm-review>${kind==='parent-assignment'?'Send for leader review':'Confirm and save'}</button><button type="button" class="back-button" data-back-review>${backLabel("Back to editing")}</button></div></div>`;
  root.append(modal);modal.showModal?.();
  const rememberChoice=()=>{if(!notificationChoice)return;let input=form.querySelector<HTMLInputElement>('[name=notify_parents]');if(!input){input=root.ownerDocument.createElement('input');input.type='hidden';input.name='notify_parents';form.append(input);}input.value=String(modal.querySelector<HTMLInputElement>('[data-notify-parents]')!.checked);};
  const close=()=>{rememberChoice();modal.remove();};modal.querySelector('[data-back-review]')!.addEventListener('click',close);
  modal.querySelector('[data-confirm-review]')!.addEventListener('click',()=>{close();if(!form.isConnected)return;confirmed.add(form);form.requestSubmit();});
  modal.addEventListener('cancel',()=>{modal.remove();});
 }
 root.addEventListener('submit',intercept,true);
 return ()=>root.removeEventListener('submit',intercept,true);
}
