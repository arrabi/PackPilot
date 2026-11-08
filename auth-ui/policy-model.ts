export interface PolicyStatus {
    eligible: boolean;
    accepted: boolean;
    version: string;
    terms_hash: string;
    privacy_hash: string;
    terms: string;
    privacy: string;
}
export function escapePolicy(value: string) { return value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!)); }
export function policyMarkdown(source: string): string {
    const inline = (text: string) => escapePolicy(text).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/\[([^\]]+)\]\((https:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    const blocks = source.trim().split(/\n\s*\n/);
    return blocks.map(block => { const heading = /^(#{1,3}) (.+)$/.exec(block); if (heading)
        return `<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`; if (block.startsWith('- '))
        return '<ul>' + block.split('\n').map(line => '<li>' + inline(line.replace(/^- /, '')) + '</li>').join('') + '</ul>'; return '<p>' + inline(block).replace(/  \n/g, '<br>').replace(/\n/g, ' ') + '</p>'; }).join('\n');
}
