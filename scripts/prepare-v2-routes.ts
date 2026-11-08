import {copyFileSync, mkdirSync} from 'node:fs';
import {join} from 'node:path';

export const v2Pages = ['index','parents','events','calendar','planner','images','notes','history','admin','data-export'] as const;

/** Preserve the previous design at real directory indexes; the current design uses root entries. */
export function prepareV2Routes(outputDirectory:string):void {
 for(const page of v2Pages){
  const directory=join(outputDirectory,'prev',page==='index'?'':page);
  mkdirSync(directory,{recursive:true});
  copyFileSync(join(outputDirectory,page+'.html'),join(directory,'index.html'));
 }
}
