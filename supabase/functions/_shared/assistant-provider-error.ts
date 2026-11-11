export interface ProviderErrorInfo {status:number;code?:string;type?:string;param?:string;hint?:'unsupported_option'}

/** Only structural error metadata is safe to expose; never copy the provider's
 * message/body, which can echo keys, prompts or record values. */
export async function readProviderError(response:Response):Promise<ProviderErrorInfo>{
 const info:ProviderErrorInfo={status:response.status};
 let error;try{error=(await response.json())?.error;}catch{return info;}
 for(const field of ['code','type'] as const)if(typeof error?.[field]==='string'&&/^[a-z_]{1,60}$/.test(error[field]))info[field]=error[field];
 if(typeof error?.param==='string'&&/^(model|temperature|max_output_tokens|parallel_tool_calls|tool_choice|tools|store|input|instructions|reasoning|include)(?:\[\d{1,3}\]|\.[a-z_]{1,40}){0,12}$/.test(error.param))info.param=error.param;
 // Some providers leave code/param null and explain rejected options only in
 // prose. Infer only a fixed option name and category, never copy that prose.
 if(typeof error?.message==='string'&&/unsupported|not supported|does not support|unrecognized|unknown parameter/i.test(error.message)){
  const matches=[...error.message.matchAll(/\b(max_output_tokens|parallel_tool_calls|tool_choice)\b/g)];
  if(matches.length){info.param??=matches[0][1];info.hint='unsupported_option';}
 }
 return info;
}
