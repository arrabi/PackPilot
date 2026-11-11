/** Deployments are explicit; unknown/local modes cannot accidentally expose AI. */
export const assistantEnvironmentEnabled=(environment:string|undefined)=>environment==='staging'||environment==='production';
