import{leaderTaskLink}from'./app-shell.ts';
import { escapeHtml as h, todayLA, type PortalData, type Scout } from './portal-model.ts';
export function needsAttention(data: PortalData, scouts: Scout[]) {
    const ids = new Set(scouts.map(s => s.id));
    const name = (id: string) => scouts.find(s => s.id === id)?.scout_name || 'Scout';
    const rows: {
        label: string;
        href: string;
    }[] = [];
    for (const a of data.assignments.filter(a => ids.has(a.scout_id))) {
        if (a.status === 'submitted')
            rows.push({ label: `${name(a.scout_id)}: home work awaiting review`, href: leaderTaskLink(a.scout_id,'family','assignment-'+a.id) });
        if (['todo', 'returned'].includes(a.status) && a.due_on && a.due_on < todayLA())
            rows.push({ label: `${name(a.scout_id)}: overdue home assignment`, href: leaderTaskLink(a.scout_id,'family','assignment-'+a.id) });
    }
    for (const id of new Set(data.familyMessages.filter(m => ids.has(m.scout_id) && m.unread).map(m => m.scout_id)))
        rows.push({ label: `${name(id)}: unread family messages`, href: leaderTaskLink(id,'family','parent-family-messages') });
    for (const s of scouts)
        for (const platform of ['active.com', 'scouting.org'])
            if (!data.registrations.some(r => r.scout_id === s.id && r.platform === platform && r.status === 'confirmed'))
                rows.push({ label: `${name(s.id)}: ${platform} ${data.registrationReports?.some(r=>r.scout_id===s.id&&r.platform===platform)?'submitted — verify registration':'registration needs follow-up'}`, href: leaderTaskLink(s.id,'registration') });
    for (const a of data.advancement.filter(a => ids.has(a.scout_id) && a.earned_on && !a.badge_delivered_on))
        rows.push({ label: `${name(a.scout_id)}: ${data.adventures.find(d => d.id === a.adventure_id)?.name || 'Badge'} awaiting handout`, href: leaderTaskLink(a.scout_id,'adventures','adventure-'+a.adventure_id) });
    return `<section class="panel"><h2>Needs attention · ${rows.length}</h2>${rows.length ? `<ul>${rows.map(r => `<li><a href="${h(r.href)}">${h(r.label)}</a></li>`).join('')}</ul>` : '<p>All caught up in this view.</p>'}</section>`;
}
