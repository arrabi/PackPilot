import {isWithdrawnScout,todayLA,type PortalData,type Scout} from './portal-model.ts';

export interface FamilyWorkScout {
 scout:Scout;
 totalAssigned:number;
 activeAssigned:number;
 readyToReview:number;
 unreadMessages:number;
 overdue:number;
 needsAttention:boolean;
 group:'attention'|'assigned'|'none';
}
/** All counts come from the authorized, current-year family records already loaded by the portal. */
export function familyWorkOverview(data:PortalData,scouts:Scout[],today=todayLA()):FamilyWorkScout[] {
 return scouts.filter(s=>!isWithdrawnScout(s)).map(scout=>{
  const assignments=data.assignments.filter(a=>a.scout_id===scout.id);
  const activeAssigned=assignments.filter(a=>['todo','returned','submitted'].includes(a.status)).length;
  const readyToReview=assignments.filter(a=>a.status==='submitted').length;
  const unreadMessages=data.familyMessages.filter(m=>m.scout_id===scout.id&&m.sender_role==='parent'&&m.unread).length;
  const overdue=assignments.filter(a=>['todo','returned'].includes(a.status)&&!!a.due_on&&a.due_on<today).length;
  const needsAttention=readyToReview+unreadMessages+overdue>0;
  return {scout,totalAssigned:assignments.length,activeAssigned,readyToReview,unreadMessages,overdue,needsAttention,group:needsAttention?'attention' as const:assignments.length?'assigned' as const:'none' as const};
 }).sort((a,b)=>{
  const priority={attention:0,assigned:1,none:2};
  return priority[a.group]-priority[b.group]||(a.group==='assigned'&&b.group==='assigned'?Number(b.activeAssigned>0)-Number(a.activeAssigned>0):0)||(a.scout.scout_name||'').localeCompare(b.scout.scout_name||'')||a.scout.id.localeCompare(b.scout.id);
 });
}
export function familyAttentionLabels(row:FamilyWorkScout):string[] {
 return [row.readyToReview?`${row.readyToReview} ready to review`:'',row.unreadMessages?`${row.unreadMessages} unread parent message${row.unreadMessages===1?'':'s'}`:'',row.overdue?`${row.overdue} overdue task${row.overdue===1?'':'s'}`:''].filter(Boolean);
}
