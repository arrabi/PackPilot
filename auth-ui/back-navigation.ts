import {escapeHtml} from './portal-model.ts';

/** Shared decoration; the caller keeps its existing href or back-step handler. */
export function backLabel(label: string): string {
  return `<svg class="back-button-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="m12 5-7 7 7 7M5 12h14"/></svg><span>${escapeHtml(label)}</span>`;
}
