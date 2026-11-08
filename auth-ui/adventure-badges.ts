import manifest from '../catalog/badge-images.json' with {type:'json'};

// Names/ranks keep references independent of an operator's generated catalog IDs.
const key = (name:string, rank:string) => `${rank.trim().toLowerCase()}:${name.trim().toLowerCase()}`;
const images = new Map(manifest.badges.map(b => [key(b.name,b.rank),b.image_url]));
export function adventureBadgeUrl(adventure:{name?:string;rank?:string}):string {
 const url = images.get(key(adventure.name || '',adventure.rank || '')) || '';
 return /^https:\/\/www\.scouting\.org\/wp-content\/uploads\//.test(url) ? url : '';
}
