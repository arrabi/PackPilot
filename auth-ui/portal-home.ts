import {badgeArt} from './badge-art.ts';
import { compareAdventures, denName, denRank, escapeHtml as h, isWithdrawnScout, rankName, type PortalData, type Scout } from "./portal-model.ts";

/** Each denominator contains only adventures for the scout's current rank. */
export function homeProgress(data: PortalData, roster: Scout[]) {
  const scouts = roster.filter((s) => !isWithdrawnScout(s));
  const earned = new Set(data.advancement.filter((a) => a.earned_on).map((a) => `${a.scout_id}:${a.adventure_id}`));
  const delivered = new Set(data.advancement.filter((a) => a.earned_on && a.badge_delivered_on).map((a) => `${a.scout_id}:${a.adventure_id}`));
  const progress = new Set(data.progress.map((p) => `${p.scout_id}:${p.adventure_id}:${p.requirement_code}`));
  const rows = scouts.map((scout) => {
    const adventures = data.adventures.filter((a) => a.rank === denRank(scout.den));
    const states = adventures.map((adventure) => {
      const key = `${scout.id}:${adventure.id}`;
      const done = earned.has(key);
      return { adventure, earned: done, waiting: done && !delivered.has(key), completed: adventure.requirements.filter((r) => done || progress.has(`${key}:${r.code}`)).length };
    });
    const core = states.filter((a) => a.adventure.catalog_context?.adventure_type === "Required (Core)");
    return { scout, core: core.length, coreEarned: core.filter((a) => a.earned).length, states };
  });
  const states = rows.flatMap((r) => r.states);
  const core = rows.reduce((n,r) => n+r.core,0), coreEarned = rows.reduce((n,r) => n+r.coreEarned,0);
  const started = states.filter((s) => !s.earned && s.completed > 0).length;
  const adventures = data.adventures.map((adventure) => {
    const relevant = states.filter((s) => s.adventure.id === adventure.id);
    return { adventure, total: relevant.length, earned: relevant.filter((s) => s.earned).length, started: relevant.filter((s) => !s.earned && s.completed > 0).length };
  }).filter((a) => a.total > a.earned).sort((a,b) => {
    const coreOrder = Number(b.adventure.catalog_context?.adventure_type === "Required (Core)") - Number(a.adventure.catalog_context?.adventure_type === "Required (Core)");
    return coreOrder || (b.total-b.earned)-(a.total-a.earned) || compareAdventures(a.adventure,b.adventure);
  });
  return { rows, core, coreEarned, started, earned: states.filter((s) => s.earned).length, waiting: states.filter((s) => s.waiting).length, requirements: states.reduce((n,s) => n+s.completed,0), adventures };
}
const pct = (n: number, total: number) => total ? Math.round(100*n/total) : 0;
function bar(earned: number, started: number, total: number, label: string) {
  const split = total ? 100*earned/total : 0, partial = total ? 100*started/total : 0;
  return `<svg class="journey-bar" viewBox="0 0 100 8" preserveAspectRatio="none" role="img" aria-label="${h(label)}"><rect width="100" height="8" rx="4" class="bar-track"/><rect width="${split}" height="8" rx="4" class="bar-earned"/><rect x="${split}" width="${partial}" height="8" class="bar-started"/></svg>`;
}
export function renderHome(data: PortalData, scouts: Scout[], den: string, year: string) {
  const p = homeProgress(data,scouts), percent = pct(p.coreEarned,p.core);
  const dens = [...new Set(p.rows.map((r) => r.scout.den))].sort((a,b) => (a || "").localeCompare(b || ""));
  const landscape = `<svg class="journey-landscape" viewBox="0 0 1000 380" preserveAspectRatio="xMidYMax slice" aria-hidden="true"><circle cx="810" cy="83" r="48" fill="#e6c578"/><path d="M0 300 180 140 310 250 470 65 750 310 900 160 1000 270V380H0Z" fill="#396c57"/><path d="m375 156 95-91 95 91-62-28-30 15-30-18Z" fill="#b2c7a2"/><path d="M0 330 200 275 390 310 650 235 1000 330V380H0Z" fill="#234d3d"/><path d="M0 370Q300 285 1000 350V380H0Z" fill="#173e32"/><path d="M540 380Q490 345 600 330T650 290" stroke="#d9c293" stroke-width="4" stroke-dasharray="7 9" fill="none"/><path d="M650 290v-32l22 6-22 8" stroke="#e6c578" stroke-width="3" fill="none"/></svg>`;
  return `<div class="home-dashboard">
    <section class="journey-hero" aria-labelledby="home-title">${landscape}<div class="journey-intro"><p class="eyebrow">PACKPILOT · ${h(year)} · ${h(den ? denName(den) : "ALL DENS")}</p><h1 id="home-title">Small steps.<br>Big adventures.</h1><p>Every new skill is a little more confidence.<br>Here’s how ${den ? "your den is" : "our scouts are"} moving along the trail.</p><a class="button journey-cta" href="#next">Plan the next adventure <span aria-hidden="true">→</span></a></div><div class="journey-ring-card"><svg class="journey-ring" viewBox="0 0 200 200" role="img" aria-label="${p.coreEarned} of ${p.core} required scout-adventures earned${p.core ? `, ${percent}%` : ', no matching required catalog'}"><circle cx="100" cy="100" r="80" class="ring-track"/><circle cx="100" cy="100" r="80" class="ring-value" pathLength="100" stroke-dasharray="${p.core ? 100*p.coreEarned/p.core : 0} 100" transform="rotate(-90 100 100)"/><text x="100" y="100" class="ring-number">${p.core ? percent+'%' : '—'}</text><text x="100" y="123" class="ring-caption">REQUIRED EARNED</text></svg><p><strong>${p.coreEarned} of ${p.core}</strong> scout-adventures</p><small>Each required adventure × scouts in its den</small></div></section>
    <div class="journey-metrics"><a href="#scouts"><span class="metric-symbol">◉</span><strong>${p.rows.length}</strong><span>Scouts on the trail</span></a><a href="#adventures"><span class="metric-symbol">✦</span><strong>${p.earned}</strong><span>Adventures earned</span></a><a href="#adventures"><span class="metric-symbol">→</span><strong>${p.started}</strong><span>Adventures in progress</span></a><a href="#followups"><span class="metric-symbol">★</span><strong>${p.waiting}</strong><span>Badges to celebrate & hand out</span></a></div>
    ${!p.rows.length ? '<section class="panel empty-state"><h2>No scouts match this view</h2><p>Choose another den or clear the scout search to see their trail.</p></section>' : `<div class="journey-main-grid"><section class="panel den-trails"><div class="panel-heading"><div><p class="eyebrow">THE BIG PICTURE</p><h2>${den ? 'Your den’s trail' : 'Every den, moving forward'}</h2></div><span class="journey-chip">Required adventures</span></div><p class="muted">Earned adventures across each scout’s required catalog.</p>${dens.map((d) => {
      const rows = p.rows.filter((r) => r.scout.den === d), total = rows.reduce((n,r) => n+r.core,0), done = rows.reduce((n,r) => n+r.coreEarned,0);
      const started = rows.flatMap((r) => r.states).filter((s) => s.adventure.catalog_context?.adventure_type === "Required (Core)" && !s.earned && s.completed > 0).length;
      return `<button class="den-trail-row" data-action="home-den" data-den="${h(d || '')}" ${d ? '' : 'disabled'}><span class="trail-row-heading"><strong>${h(denName(d))}</strong><span>${total ? pct(done,total)+'%' : 'No catalog'}</span></span>${bar(done,started,total,`${denName(d)}: ${done} of ${total} required scout-adventures earned; ${started} in progress`)}<span class="trail-row-foot"><span>${rows.length} scouts</span><span>${done} / ${total} earned · ${started} in progress</span></span></button>`;
    }).join('')}<div class="journey-legend"><span class="legend-earned">Earned</span><span class="legend-started">In progress</span><span class="legend-empty">No progress recorded</span></div></section><section class="journey-next panel"><p class="eyebrow">MAKE THE NEXT MEETING COUNT</p><h2>A little progress.<br>A big moment.</h2><p><strong>${p.requirements}</strong> requirement completions recorded or covered by earned adventures in this view.</p><a class="button primary" href="#attendance">Take attendance <span aria-hidden="true">→</span></a><a class="button secondary" href="#next">Find what to work on</a><p class="form-note">Missing records mean “not recorded.” Charts reflect this program year, not a scout’s full history. Required progress is not a rank award decision.</p></section></div>
    <section class="journey-adventures"><div class="panel-heading"><div><p class="eyebrow">ROOM FOR THE NEXT DISCOVERY</p><h2>Adventures to move forward</h2></div><a class="text-link" href="#adventures">View all adventures →</a></div><p class="muted">Required first, then those needed by the most scouts. Tap an adventure to open its recording page.</p><div class="journey-adventure-grid">${p.adventures.slice(0,6).map(({adventure:a,total,earned,started},i) => `<button class="journey-adventure-card journey-tone-${i%3}" data-action="plan-adventure" data-id="${h(a.id)}"><span class="adventure-card-top"><span class="adventure-emblem" aria-hidden="true">${badgeArt(a)||['✦','⌁','✧'][i%3]}</span><span class="journey-chip">${h(rankName(a.rank))} · ${a.catalog_context?.adventure_type === 'Required (Core)' ? 'Required' : a.catalog_context?.adventure_type === 'Elective' ? 'Elective' : 'Adventure'}</span></span><h3>${h(a.name)}</h3><p>${total-earned} of ${total} scouts still need this adventure</p>${bar(earned,started,total,`${a.name}: ${earned} earned, ${started} in progress, ${total} scouts`)}<span class="adventure-card-bottom">${earned} earned · ${started} in progress <b aria-hidden="true">→</b></span></button>`).join('') || '<div class="panel"><h3>Look how far they’ve come!</h3><p>All available adventures in this view have been earned, or no matching catalog is available. Open Adventures to review the records.</p></div>'}</div></section>
    <section class="panel scout-trails"><div class="panel-heading"><div><p class="eyebrow">EVERY SCOUT HAS A STORY</p><h2>Individual trails</h2></div><a class="text-link" href="#scouts">Open scout fieldbooks →</a></div><p class="muted">Required adventures earned. Open a scout to see requirements, dates, and badges.</p><div class="scout-trail-grid">${p.rows.slice(0,6).map(scoutRow).join('')}</div>${p.rows.length > 6 ? `<details class="more-scout-trails"><summary>See all ${p.rows.length} scouts</summary><div class="scout-trail-grid">${p.rows.slice(6).map(scoutRow).join('')}</div></details>` : ''}</section>`}
    <a class="journey-overview-link" href="#overview">Looking for registrations, recent activities, or the Claude connection guide? Open Overview →</a></div>`;
}
function scoutRow(r: ReturnType<typeof homeProgress>['rows'][number]) {
  return `<a class="scout-trail" href="#scout/${h(r.scout.id)}"><span class="trail-row-heading"><strong>${h(r.scout.scout_name || 'Name not recorded')}</strong><span>${r.coreEarned}/${r.core}</span></span>${bar(r.coreEarned,0,r.core,`${r.scout.scout_name}: ${r.coreEarned} of ${r.core} required adventures earned`)}<small>${h(denName(r.scout.den))} · ${r.core ? pct(r.coreEarned,r.core)+'% earned' : 'No matching catalog'}</small></a>`;
}
