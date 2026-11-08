import {adventureBadgeUrl} from './adventure-badges.ts';
import {escapeHtml as h, type Adventure} from './portal-model.ts';

/** Decorative artwork: the adjacent adventure name supplies its accessible label. */
export function badgeArt(adventure: Adventure, extraClass = ''): string {
 const src = adventureBadgeUrl(adventure);
 return src ? `<img class="adventure-badge ${h(extraClass)}" src="${h(src)}" alt="" width="48" height="64" referrerpolicy="no-referrer" loading="lazy" decoding="async">` : '';
}
