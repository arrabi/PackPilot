import {parsePhoneNumberFromString} from 'libphonenumber-js/min';
import {escapeHtml as h} from './portal-model.ts';

function parsedPhone(value:string|null|undefined) {
 if(!value?.trim())return undefined;
 const parsed=parsePhoneNumberFromString(value.trim(),{defaultCountry:'US',extract:false});
 return parsed?.isPossible()?parsed:undefined;
}
/** Presentation only: keep original stored values, and never guess missing digits. */
export function formatPhoneNumber(value:string|null|undefined):string {
 const parsed=parsedPhone(value);
 if(!parsed)return value?.trim()||'';
 return parsed.countryCallingCode==='1'?parsed.formatNational():parsed.formatInternational();
}
export function phoneLink(value:string|null|undefined,empty='Phone not recorded'):string {
 const parsed=parsedPhone(value),label=formatPhoneNumber(value)||empty;
 return parsed?`<a href="${h(parsed.getURI())}">${h(label)}</a>`:h(label);
}
export const isPhoneField=(field:string)=>/(?:^|_)(?:phone|telephone|tel)(?:_|$)/i.test(field);
