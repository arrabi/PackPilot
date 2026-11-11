import {escapeHtml as h} from './portal-model.ts';
export interface BuildInfo {version:string;commit:string;builtAt:string;environment:'staging'|'production'|'development'}
declare const __APP_BUILD__:BuildInfo|undefined;
export const currentBuildInfo=()=>typeof __APP_BUILD__==='undefined'?undefined:__APP_BUILD__;

export function buildDetails(build:BuildInfo|undefined=currentBuildInfo()){
 if(!build)return '<p class="app-build">Development build</p>';
 const environment={staging:'Staging',production:'Production',development:'Development'}[build.environment];
 const commit=/^[a-f0-9]{40}$/.test(build.commit)?build.commit.slice(0,12):'local';
 const date=new Date(build.builtAt);
 const formatted=Number.isFinite(date.getTime())?new Intl.DateTimeFormat('en-US',{month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit',timeZone:'America/Los_Angeles',timeZoneName:'short'}).format(date):'';
 return `<p class="app-build"><span>${environment} · v${h(build.version)} · Build ${commit}</span>${formatted?` <span>Built <time datetime="${h(build.builtAt)}">${h(formatted)}</time></span>`:''}</p>`;
}
