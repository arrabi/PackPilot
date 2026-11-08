/** Keep in-progress callbacks on their origin; ordinary visits use the new portal. */
export function portalTransition(url) {
    if (url.origin !== 'https://legacy.packpilot.example')
        return null;
    const params = new URLSearchParams(url.hash.slice(1));
    if (['/oauth/consent', '/consent.html'].includes(url.pathname) ||
        ['code', 'state', 'authorization_id', 'access_token', 'refresh_token', 'token_hash', 'error', 'error_code', 'error_description'].some(key => url.searchParams.has(key) || params.has(key)))
        return null;
    return 'https://packpilot.example' + url.pathname + url.search + url.hash;
}
if (typeof window !== 'undefined' && window.location.origin === 'https://legacy.packpilot.example') {
    const target = portalTransition(new URL(window.location.href));
    if (target)
        window.location.replace(target);
}
