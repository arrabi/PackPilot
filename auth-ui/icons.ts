/** Small decorative icons. Visible labels always carry the meaning. */
export function icon(name:string,className='ui-icon') {
 const paths:Record<string,string>={
 lock:'<rect x="5" y="10" width="14" height="12" rx="2"/><path d="M8 10V6a4 4 0 0 1 8 0v4"/>',
 notebook:'<rect x="5" y="2" width="16" height="20" rx="2"/><path d="M2 6h6M2 12h6M2 18h6"/>',
 home:'<path d="m3 10 9-7 9 7v11h-6v-7H9v7H3z"/>',
 book:'<path d="M12 5c-3-2-7-2-10 0v15c3-2 7-2 10 0 3-2 7-2 10 0V5c-3-2-7-2-10 0Zm0 0v15"/>',
 shield:'<path d="M12 2 3 6v6c0 5 9 10 9 10s9-5 9-10V6z"/><path d="m8 12 3 3 5-6"/>',
 ticket:'<path d="M3 5h18v5a2 2 0 0 0 0 4v5H3v-5a2 2 0 0 0 0-4z"/><path d="M15 5v3m0 3v2m0 3v3"/>',
 message:'<path d="M21 4H3v13h5v5l6-5h7z"/>',
 calendar:'<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 2v6m10-6v6M3 11h18"/>',
 clock:'<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/>',
 pin:'<path d="M19 9c0 5-7 12-7 12S5 14 5 9a7 7 0 0 1 14 0Z"/><circle cx="12" cy="9" r="2"/>',
 check:'<path d="m5 12 4 4L19 6"/>',
 alert:'<path d="m12 3 10 18H2zM12 9v5m0 3v1"/>',
 sparkle:'<path d="m12 3 2.4 6.6L21 12l-6.6 2.4L12 21l-2.4-6.6L3 12l6.6-2.4Z"/>',
 photo:'<rect x="2" y="5" width="20" height="16" rx="2"/><path d="m7 5 2-3h6l2 3"/><circle cx="12" cy="13" r="4"/>',
 people:'<circle cx="9" cy="7" r="4"/><path d="M2 21v-3a7 7 0 0 1 14 0v3m0-18a4 4 0 0 1 0 8m3 4a6 6 0 0 1 3 6"/>',
 award:'<circle cx="12" cy="8" r="6"/><path d="m7 13-2 9 7-4 7 4-2-9"/>',
 more:'<path d="M3 6h18M3 12h18M3 18h18"/>',
 refresh:'<path d="M20 8a8 8 0 1 0 0 8M20 2v6h-6"/>',
 };
 return `<svg class="${className}" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths[name]||paths.award}</svg>`;
}
