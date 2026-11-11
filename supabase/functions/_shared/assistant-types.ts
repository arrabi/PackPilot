export interface AssistantItem { label: string; detail: string; value?: string; scout_id?: string }
export interface ReviewRow { label: string; detail: string; before: string; after: string; date: string; scout_id: string }
export interface AssistantCommand { action: string; scout_id: string; occurred_on: string; [key: string]: unknown }
export interface AssistantReview {
 kind: 'review'; id: string; title: string; rows: ReviewRow[];
 commands: AssistantCommand[]; expires_at: string; notifications: boolean;
}
export type AssistantCard =
 | {kind:'results'|'choices'; title:string; items:AssistantItem[]}
 | AssistantReview
 | {kind:'saved'; title:string; rows:ReviewRow[]; notificationsQueued:number};
export interface AssistantReply { message:string; card?:AssistantCard }
export type AssistantTransport = (input:Record<string,unknown>)=>Promise<AssistantReply>;
