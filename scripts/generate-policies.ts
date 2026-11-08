import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { policyMarkdown } from '../auth-ui/policy-model.ts';
const transition = ts.transpileModule(await readFile('auth-ui/domain-transition.ts', 'utf8'), {compilerOptions:{target:ts.ScriptTarget.ES2023,module:ts.ModuleKind.ESNext}}).outputText;
const version = '2026-11-02.2';
const terms = await readFile('documentation/policies/terms-of-use.md', 'utf8');
const privacy = await readFile('documentation/policies/privacy-policy.md', 'utf8');
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
await mkdir('auth-ui/public', { recursive: true });
await writeFile('auth-ui/public/domain-transition.js', transition);
await writeFile('auth-ui/public/policy.css', await readFile('auth-ui/policy.css', 'utf8'));
for (const [name, body] of [['terms', terms], ['privacy', privacy]])
    await writeFile(`auth-ui/public/${name}.html`, `<!doctype html><html lang="en"><head><script type="module" src="/domain-transition.js"></script><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="referrer" content="no-referrer"><meta name="policy-version" content="${version}"><meta name="policy-hash" content="${sha(body)}"><title>PackPilot · ${name === 'terms' ? 'Terms of Use' : 'Privacy Policy'}</title><link rel="stylesheet" href="/policy.css"></head><body class="policy-page-body"><main class="policy-page">${policyMarkdown(body)}</main><footer class="policy-footer"><a href="/terms">Terms of Use</a><a href="/privacy">Privacy Policy</a><a href="/">Leader portal</a><a href="/parents">Parent portal</a></footer></body></html>`);
const escaped = (s: string) => "'" + s.replaceAll("'", "''") + "'";
await writeFile('/tmp/pack99-policy-seed.sql', `begin;
do $$begin
 if exists(select 1 from private.site_policy_acceptances) then
  raise exception 'Initial policy seed requires an installation with no policy acceptances; publish a new policy version for existing users';
 end if;
end$$;
update private.site_policy_versions set current=false where current;
insert into private.site_policy_versions(version,terms,privacy,terms_hash,privacy_hash,current)values('${version}',${escaped(terms)},${escaped(privacy)},'${sha(terms)}','${sha(privacy)}',true)
on conflict(version) do update set terms=excluded.terms,privacy=excluded.privacy,terms_hash=excluded.terms_hash,privacy_hash=excluded.privacy_hash,current=true;
commit;\n`);
console.log('Generated policy pages and matching versioned database seed.');
