import {prepareV2Routes} from '../scripts/prepare-v2-routes.ts';
import { defineConfig, loadEnv } from "vite";
import { fileURLToPath } from "node:url";
import {execFileSync} from 'node:child_process';
export default defineConfig(({mode}) => {
 const staging = mode === 'staging';
 let commit = 'development';
 try { commit = execFileSync('git', ['rev-parse', 'HEAD'], {cwd:fileURLToPath(new URL('..', import.meta.url)),encoding:'utf8'}).trim(); } catch { /* Unpacked source can still be built locally. */ }
 const release = /^[a-f0-9]{40}$/.test(commit) ? commit.slice(0,12) : 'development';
 const env = loadEnv(mode, fileURLToPath(new URL('.', import.meta.url)), 'VITE_');
 if(staging){
  if(!/^https:\/\/[a-z]{20}\.supabase\.co$/.test(env.VITE_SUPABASE_URL || '') || env.VITE_SUPABASE_URL.includes('aaaaaaaaaaaaaaaaaaaa'))throw Error('Staging requires an explicit isolated Supabase URL');
  if(!env.VITE_SUPABASE_PUBLISHABLE_KEY?.startsWith('sb_publishable_'))throw Error('Staging requires an explicit publishable browser key');
 }
 return {
  plugins: [
    {
      name: 'staging-identity',
      generateBundle(_options, bundle) {
        this.emitFile({type:'asset',fileName:'release.json',source:JSON.stringify({commit,environment:staging?'staging':'production'})});
        if(!staging)return;
        for(const output of Object.values(bundle)){
          if(output.type==='chunk' && output.code.includes('https://aaaaaaaaaaaaaaaaaaaa.supabase.co'))throw Error('Staging bundle references the production backend');
        }
      },
      transformIndexHtml(html) {
        html = html.replace('</head>',`<meta name="pack99-release" content="${release}"></head>`);
        if(!staging)return html;
        return html.replace(/<title>/i,'<title>[STAGING] ')
          .replace(/<link\b[^>]*rel=["'](?:shortcut )?icon["'][^>]*>/gi,'')
          .replace('</head>','<link rel="icon" href="/staging.svg"></head>')
          .replace(/<body([^>]*)>/i,`<body$1><aside style="position:sticky;top:0;z-index:2147483647;background:#fbbf24;color:#422006;padding:12px;text-align:center;font:700 14px system-ui" role="status">STAGING — Production copy · Test emails only <small>· ${release}</small></aside>`);
      },
    },
    {
      name: 'v2-directory-pages',
      apply: 'build',
      closeBundle() {
        prepareV2Routes(fileURLToPath(new URL('./dist', import.meta.url)));
      },
    },
    {
      name: "consent-route",
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (/^\/(?:v2|prev)(?:\/|$|\?)/.test(req.url || '')) {
            const [pathname, query] = (req.url || '').split('?');
            const page = pathname.replace(/^\/(?:v2|prev)\/?/, '').replace(/\/$/, '') || 'index';
            if (['index','parents','events','calendar','planner','images','notes','history','admin','data-export'].includes(page)) {
              req.url = '/' + page + '.html' + (query ? '?' + query : ''); next(); return;
            }
          }
          if (req.url?.split("?")[0] === "/oauth/consent")
            req.url =
              "/consent.html" +
              (req.url.includes("?")
                ? req.url.slice(req.url.indexOf("?"))
                : "");
          if (["/b", "/b/", "/beta.html"].includes(req.url?.split("?")[0] || "")) {
            res.writeHead(301, { Location: "/" }); res.end(); return;
          }
          if (["/parents", "/parents/"].includes(req.url?.split("?")[0] || "")) req.url = "/parents.html";
          if (["/events", "/calendar", "/images", "/planner", "/notes", "/history", "/admin", "/data-export"].includes(req.url?.split("?")[0] || "")) { const [path,query] = req.url!.split("?"); req.url = path + ".html" + (query ? "?" + query : ""); }
          if (["/terms", "/privacy"].includes(req.url?.split("?")[0] || "")) req.url += ".html";
          if (["/community", "/community/"].includes(req.url?.split("?")[0] || "")) req.url = "/community.html" + (req.url?.includes("?") ? req.url.slice(req.url.indexOf("?")) : "");
          next();
        });
      },
    },
  ],
  build: {
    rollupOptions: {
      input: {
        "events": fileURLToPath(new URL("./events.html", import.meta.url)),
        "calendar": fileURLToPath(new URL("./calendar.html", import.meta.url)),
        "images": fileURLToPath(new URL("./images.html", import.meta.url)),
        "planner": fileURLToPath(new URL("./planner.html", import.meta.url)),
        "notes": fileURLToPath(new URL("./notes.html", import.meta.url)),
        "history": fileURLToPath(new URL("./history.html", import.meta.url)),
        "admin": fileURLToPath(new URL("./admin.html", import.meta.url)),
        "data-export": fileURLToPath(new URL("./data-export.html", import.meta.url)),

        community: fileURLToPath(new URL("./community.html", import.meta.url)),
        parents: fileURLToPath(new URL("./parents.html", import.meta.url)),
        portal: fileURLToPath(new URL("./index.html", import.meta.url)),
        consent: fileURLToPath(new URL("./consent.html", import.meta.url)),
      },
    },
  },
};
});
