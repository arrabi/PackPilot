import {currentBuildInfo} from './build-info.ts';
import {escapeHtml as h,denName,todayLA} from './portal-model.ts';
import type {AssistantCard,AssistantReply,AssistantReview,AssistantTransport} from '../supabase/functions/_shared/assistant-types.ts';

export function createAssistantPanel(doc:Document,transport:AssistantTransport,context:()=>{den:string;year:string;email:string},onSaved:()=>void,photoForScout:(id:string)=>string|undefined=()=>undefined){
 const win=doc.defaultView!;
 const environment=currentBuildInfo()?.environment;
 const deploymentLabel=environment==='production'?'PACKPILOT':environment==='staging'?'PACKPILOT · STAGING':'PACKPILOT · DEVELOPMENT';
 const dialog=doc.createElement('dialog');dialog.className='fieldbook-assistant';dialog.setAttribute('aria-labelledby','assistant-title');
 doc.body.append(dialog);
 const turns:{role:'user'|'assistant';text:string;card?:AssistantCard}[]=[];
 let draft='',busy=false,error='',activeId='',uncertain=false,needsRefresh=false,disposed=false,opener:HTMLElement|null=null;
 const key=()=>`pack99-assistant-pending:${context().email}`;
 const remember=(id:string)=>{try{if(id)win.sessionStorage.setItem(key(),id);else win.sessionStorage.removeItem(key());}catch{/* Storage is optional. */}};
 const recordHref=(hash:string)=>['/','/prev/'].includes(win.location.pathname)?hash:`/?${new URLSearchParams({den:context().den,year:context().year})}${hash}`;
 const review=()=>turns.map(t=>t.card).findLast(c=>c?.kind==='review'&&c.id===activeId) as AssistantReview|undefined;
 const button=(label:string,action:string,primary=false)=>`<button type="button" class="assistant-button ${primary?'primary':''}" data-assistant-action="${action}" ${busy?'disabled':''}>${label}</button>`;
 function focusComposer(){
  if(!disposed&&!busy&&!uncertain&&dialog.hasAttribute('open'))dialog.querySelector<HTMLTextAreaElement>('#assistant-message')?.focus({preventScroll:true});
 }
 // iOS can shrink/pan the visible viewport when the keyboard opens or the
 // page is zoomed. A modal sized only with vw/vh still uses the larger layout
 // viewport, leaving its close/Send buttons off screen.
 const viewport=win.visualViewport;
 const viewportProperties=['--assistant-viewport-width','--assistant-viewport-height','--assistant-viewport-left','--assistant-viewport-top'];
 function fitVisibleViewport(){
  if(disposed)return;
  const phone=win.matchMedia('(max-width:600px)').matches||win.matchMedia('(max-width:1000px) and (pointer:coarse)').matches;
  if(!viewport||!phone){for(const property of viewportProperties)dialog.style.removeProperty(property);return;}
  const values=[viewport.width,viewport.height,viewport.offsetLeft,viewport.offsetTop];
  values.forEach((value,i)=>dialog.style.setProperty(viewportProperties[i],`${value}px`));
 }
 win.addEventListener('resize',fitVisibleViewport);
 viewport?.addEventListener('resize',fitVisibleViewport);
 viewport?.addEventListener('scroll',fitVisibleViewport);
 function renderCard(card:AssistantCard){
  if(card.kind==='results'||card.kind==='choices')return `<section class="assistant-card"><h3>${h(card.title)}</h3><div class="assistant-rows">${card.items.map((item,i)=>{
   const portrait=item.scout_id?photoForScout(item.scout_id):undefined;
   const avatar=item.scout_id||card.kind==='choices'?`<span class="assistant-avatar" aria-hidden="true">${portrait?`<img src="${h(portrait)}" alt="">`:h(item.label.split(/\s+/).map(w=>w[0]).slice(0,2).join(''))}</span>`:'';
   const text=`<span class="assistant-result-text"><strong>${h(item.label)}</strong><small>${h(item.detail)}</small></span>`;
   return card.kind==='choices'?`<button type="button" class="assistant-choice" data-choice="${i}" ${busy?'disabled':''}>${avatar}${text}<span aria-hidden="true">›</span></button>`:`<${item.scout_id?'a':'div'} ${item.scout_id?`href="${h(recordHref('#scout/'+item.scout_id))}"`:''} class="assistant-result ${item.scout_id?'assistant-scout-result':''}">${avatar}${text}${item.scout_id?'<span aria-hidden="true">›</span>':''}</${item.scout_id?'a':'div'}>`;
  }).join('')||'<p>No matching records.</p>'}</div></section>`;
  if(!('rows' in card))return '';
  const sharedDetail=card.rows.length&&card.rows.every(row=>row.detail===card.rows[0].detail)?card.rows[0].detail:'';
  const sharedDate=card.rows.length&&card.rows.every(row=>row.date===card.rows[0].date)?card.rows[0].date:'';
  const summary=`${sharedDetail?`<p class="assistant-review-summary">${h(sharedDetail)}</p>`:''}${sharedDate?`<p class="assistant-review-date">Date · ${h(sharedDate)}</p>`:''}`;
  const rows=card.rows.map((row,i)=>`<div class="assistant-review-row">${card.kind==='review'&&card.id===activeId?`<label class="assistant-selected"><input type="checkbox" data-entry="${i}" checked ${busy||uncertain?'disabled':''}><span class="sr-only">Include ${h(row.label)}</span></label>`:'<span class="assistant-check" aria-hidden="true">✓</span>'}<div><strong>${h(row.label)}</strong>${sharedDetail?'':`<small>${h(row.detail)}</small>`}<span>${h(row.before)} → <b>${h(row.after)}</b></span>${sharedDate?'':`<small>${h(row.date)}</small>`}</div></div>`).join('');
  if(card.kind==='saved')return `<section class="assistant-card assistant-saved"><span class="assistant-state">✓ SAVED</span><h3>${h(card.title)}</h3>${summary}${rows}<p class="assistant-notifications">${card.notificationsQueued?`${card.notificationsQueued} parent notification${card.notificationsQueued===1?'':'s'} queued.`:'No immediate parent notifications queued.'}</p><a href="${h(recordHref('#badges'))}">View current records →</a><p>To correct an entry, describe the correction below.</p></section>`;
  if(card.kind!=='review')return '';
  if(card.id!==activeId)return `<section class="assistant-card assistant-inactive"><h3>${h(card.title)}</h3><p>This review is no longer active.</p></section>`;
  const dates=new Set(card.commands.map(c=>c.occurred_on));
  return `<section class="assistant-card assistant-review"><span class="assistant-state">READY TO REVIEW</span><h3>${h(card.title)}</h3>${summary}${rows}<details class="assistant-edit" ${busy||uncertain?'inert':''}><summary>Edit selection or date</summary><p>Uncheck a scout above to leave their record unchanged.</p><label>Apply date to selected updates<input type="date" data-edit-date max="${todayLA()}" value="${dates.size===1?h([...dates][0]):''}"></label><p>Attendance keeps the meeting’s recorded date.</p>${button('Update review','edit')}</details>${card.commands.some(c=>'notify_parents'in c)?`<label class="assistant-notify"><input type="checkbox" data-notify ${card.notifications?'checked':''} ${busy||uncertain?'disabled':''}><span><strong>Notify parents</strong><small>Send an immediate progress update.${environment==='staging'?' Staging delivery stays paused.':''}</small></span></label>`:''}<p class="assistant-expiry">Review expires after 30 minutes.</p>${needsRefresh?button('Review latest records','refresh',true):uncertain?button('Check save status','status',true)+button('Retry same save safely','save'):button(`Save ${card.rows.length} update${card.rows.length===1?'':'s'}`,'save',true)}${!uncertain?button('Cancel request','cancel'):''}</section>`;
 }
 function render(){
  if(disposed)return;
  const focused=doc.activeElement?.id;
  dialog.innerHTML=`<div class="assistant-shell"><header><div><span class="assistant-eyebrow">${deploymentLabel}</span><h2 id="assistant-title">Ask AI</h2></div><div class="assistant-header-actions"><button type="button" class="assistant-new-chat" data-assistant-action="new-chat" title="${uncertain?'Check the pending save before starting a new chat':busy?'Wait for the current request to finish':'Clear this conversation and start a new chat'}" ${busy||uncertain?'disabled':''}>New chat</button><button type="button" data-assistant-action="close" aria-label="Close assistant">×</button></div></header><div class="assistant-context">${h(context().den?denName(context().den):'All dens')} · ${h(context().year)}</div><div class="assistant-transcript" aria-live="polite" aria-relevant="additions text">${!turns.length?`<section class="assistant-welcome"><span class="assistant-spark" aria-hidden="true">✦</span><h3>What can I help with?</h3><p>Ask about your den or describe an update. You’ll review every change before saving.</p><div class="assistant-suggestions">${['Which badges are ready to hand out?','Who still needs Bobcat?','Show outstanding equipment loans'].map(text=>`<button type="button" data-suggestion="${h(text)}">${h(text)} →</button>`).join('')}</div></section>`:turns.map((t,index)=>`<article class="assistant-turn ${t.role}" data-turn="${index}">${t.text?`<p>${h(t.text)}</p>`:''}${t.card?renderCard(t.card):''}</article>`).join('')}${busy?'<p class="assistant-working" role="status">Working on your request…</p>':''}${error?`<div class="assistant-error" role="alert">${h(error)}</div>`:''}</div><form class="assistant-composer"><label class="sr-only" for="assistant-message">Ask a question or request a change</label><textarea id="assistant-message" rows="2" maxlength="4000" placeholder="Ask a question or request a change…" ${busy||uncertain?'disabled':''}>${h(draft)}</textarea><button type="submit" aria-label="Send message" ${busy||uncertain?'disabled':''}>↑</button></form><p class="assistant-footnote">Questions and relevant records are sent to OpenAI. Review changes.</p></div>`;
  if(focused==='assistant-message')dialog.querySelector<HTMLTextAreaElement>('#assistant-message')?.focus({preventScroll:true});
  const log=dialog.querySelector('.assistant-transcript');if(log){const last=log.querySelector('.assistant-turn:last-of-type');log.scrollTop=!busy&&last?last.getBoundingClientRect().top-log.getBoundingClientRect().top+log.scrollTop-12:log.scrollHeight;}
 }
 function accept(reply:AssistantReply){
  if(disposed)return;
  if(reply.card?.kind==='review'){activeId=reply.card.id;remember(activeId);needsRefresh=false;uncertain=false;}
  if(reply.card?.kind==='saved'){activeId='';remember('');uncertain=false;needsRefresh=false;onSaved();}
  turns.push({role:'assistant',text:reply.message,card:reply.card});
 }
 async function ask(message:string){
  if(busy||uncertain||!message.trim())return;
  busy=true;error='';draft='';
  try{
   if(activeId){await transport({action:'cancel',proposal_id:activeId});activeId='';remember('');}
   turns.push({role:'user',text:message});render();
   const history=turns.slice(-8).map(t=>({role:t.role,content:(t.text+(t.card?'\n'+JSON.stringify(t.card):'')).slice(0,5500)}));
   const reply=await transport({action:'chat',context:{den:context().den,year:context().year},messages:history});
   if(!disposed)accept(reply);
  }catch(e){if(!disposed){error=(e as Error).message;turns.push({role:'assistant',text:'This request failed; no answer or changes were produced. '+error});}}finally{busy=false;render();focusComposer();}
 }
 async function action(name:string){
  if(name==='close'){dialog.close?.();dialog.removeAttribute('open');opener?.focus();return;}
  if(name==='new-chat'){
   if(busy||uncertain)return;
   busy=true;error='';render();
   try{
    if(activeId)await transport({action:'cancel',proposal_id:activeId});
    if(disposed)return;
    turns.length=0;draft='';activeId='';needsRefresh=false;remember('');
   }catch(e){if(!disposed)error=(e as Error).message;}
   finally{busy=false;render();focusComposer();}
   return;
  }
  if(busy||!activeId)return;
  const current=review();if(!current)return;
  let commands=current.commands;
  if(name==='edit'||name==='save'){
   const included=new Set([...dialog.querySelectorAll<HTMLInputElement>('[data-entry]:checked')].map(el=>Number(el.dataset.entry)));
   const date=dialog.querySelector<HTMLInputElement>('[data-edit-date]')?.value;
   const notify=dialog.querySelector<HTMLInputElement>('[data-notify]')?.checked;
   commands=current.commands.filter((_,i)=>included.has(i)).map(c=>({...c,...(date?{occurred_on:date}:{}),...('notify_parents'in c?{notify_parents:!!notify}:{})}));
   if(!commands.length){error='Select at least one update.';render();return;}
   if(name==='save'&&!uncertain&&JSON.stringify(commands)!==JSON.stringify(current.commands)){name='edit';}
  }
  busy=true;error='';render();
  try{
   if(name==='edit'||name==='refresh')accept(await transport({action:'prepare',commands:name==='refresh'?current.commands:commands}));
   else if(name==='cancel'){accept(await transport({action:'cancel',proposal_id:activeId}));activeId='';remember('');}
   else{
    if(name==='save')uncertain=true;
    const reply=await transport({action:name==='status'?'status':'confirm',proposal_id:activeId});
    if(reply.card?.kind==='review'){
     uncertain=false;
     // Status reads restore the same proposal, without creating a second draft.
     turns.push({role:'assistant',text:'This proposal is still pending. You can retry the same save safely.'});
    }else accept(reply);
   }
  }catch(e){
   const problem=e as Error&{code?:string};error=problem.message;
   if(['conflict','validation','expired','access'].includes(problem.code??'')){uncertain=false;needsRefresh=true;}
   else if(name==='save')uncertain=true;
  }finally{busy=false;render();}
 }
 dialog.addEventListener('input',event=>{if((event.target as HTMLElement).id==='assistant-message')draft=(event.target as HTMLTextAreaElement).value;});
 dialog.addEventListener('submit',event=>{event.preventDefault();void ask(draft);});
 dialog.addEventListener('click',event=>{
  const target=event.target as HTMLElement;
  const control=target.closest<HTMLElement>('[data-assistant-action],[data-choice],[data-suggestion]');
  if(control?.hasAttribute('disabled'))return;
  if(control?.dataset.assistantAction)void action(control.dataset.assistantAction);
  if(control?.dataset.suggestion)void ask(control.dataset.suggestion);
  if(control?.dataset.choice!==undefined){const turn=control.closest<HTMLElement>('[data-turn]');const card=turn?turns[Number(turn.dataset.turn)].card:null;if(card?.kind==='choices'){const item=card.items[Number(control.dataset.choice)];void ask(item.value||`I mean ${item.label}.`);}}
  if(target.closest('.assistant-card a')){dialog.close?.();dialog.removeAttribute('open');}
 });
 dialog.addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey&&(event.target as HTMLElement).id==='assistant-message'){event.preventDefault();void ask(draft);}});
 const beforeUnload=(event:BeforeUnloadEvent)=>{if(uncertain||busy){event.preventDefault();event.returnValue='';}};win.addEventListener('beforeunload',beforeUnload);
 return{
  async open(){opener=doc.activeElement as HTMLElement;fitVisibleViewport();render();if(dialog.showModal)dialog.showModal();else dialog.setAttribute('open','');focusComposer();
   if(!activeId&&!turns.length){let stored='';try{stored=win.sessionStorage.getItem(key())||'';}catch{}if(stored){busy=true;render();try{const reply=await transport({action:'status',proposal_id:stored});if(!disposed)accept(reply);}catch(e){error=(e as Error).message;remember('');}finally{busy=false;render();}}}
  },
  hasPending:()=>busy||uncertain,
  dispose(){disposed=true;dialog.remove();win.removeEventListener('beforeunload',beforeUnload);win.removeEventListener('resize',fitVisibleViewport);viewport?.removeEventListener('resize',fitVisibleViewport);viewport?.removeEventListener('scroll',fitVisibleViewport);},
 };
}
