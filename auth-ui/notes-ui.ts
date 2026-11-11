import {icon} from './icons.ts';
import {escapeHtml as h} from './portal-model.ts';
import type {WorkspaceData} from './workspace-model.ts';

type Note = NonNullable<WorkspaceData['notes']>[number];

function noteForm(note?:Note) {
 const id=note?.id||'personal';
 return `<form class="my-notes-form" data-kind="note" data-id="${h(note?.id||'')}" data-revision="${note?.revision||0}">
 <input type="hidden" name="expected_revision" value="${note?.revision||0}"><input type="hidden" name="den" value="${h(note?.den||'')}">
 <label for="note-${h(id)}">${note?.den?h(note.den.slice(2)+' notes'):'Your notes'}</label>
 <textarea id="note-${h(id)}" name="body" maxlength="20000" placeholder="Jot down ideas, reminders, or things to follow up on…" aria-describedby="notes-privacy note-meta-${h(id)}">${h(note?.body||'')}</textarea>
 <div id="note-meta-${h(id)}" class="my-notes-meta"><span data-note-state role="status"></span><span data-note-count>${(note?.body||'').length.toLocaleString('en-US')} / 20,000</span></div>
 <div class="my-notes-actions"><button type="button" class="button secondary" data-notes-cancel>Cancel</button><button class="button primary" data-note-save>Save notes</button></div></form>`;
}

export function renderMyNotes(data:WorkspaceData) {
 const mine=(data.notes||[]).filter(note=>note.owner_id===data.user_id);
 const previous=mine.filter(note=>note.den);
 return `<div id="notes-privacy" class="my-notes-privacy">${icon('lock')}<p>These are your private notes.<br>Only you can see them.</p></div>
 ${noteForm(mine.find(note=>!note.den))}
 ${previous.length?`<details class="my-notes-previous" data-state-key="previous-den-notes"><summary>Previous den notes</summary><p>Your existing den notes are still here. Only you can see them.</p>${previous.map(note=>`<details data-state-key="note-${h(note.id)}"><summary>${h(note.den.slice(2))}</summary>${noteForm(note)}</details>`).join('')}</details>`:''}`;
}
