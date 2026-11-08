# PackPilot contributor instructions

Read README.md, documentation/SETUP.md and ReleaseRunbook.md before changing or deploying this public starter.

- Keep the Supabase + Cloudflare Pages + Google OAuth + Brevo architecture for this version. Keep authentication, verified Google identity, family/leader permissions, policy acceptance and notification safeguards intact.
- The committed configuration is synthetic. Configure a private instance before its first migration; never publish secrets, private roster records, real family fixtures or live deployment receipts.
- Make changes on a branch and run npm ci, npm run check and the Python tests. Preserve applied migration history after installation.
- Only validation workflows are active. Deployment workflow examples are inactive and require instance-specific review and fresh-install baseline work. Do not fabricate recovery acceptance or enable deployment by copying another instance's metadata.
- Never contact an unrelated live project. Use disposable fixtures for tests, preserve mail pause/allowlists, and never invoke an authenticated parent dispatcher as a deployment check.
- A first installation of a new empty instance may use the explicit provider CLI steps in SETUP.md. Updates to real records require a verified backup, deliberate approval and the failure/maintenance procedure in ReleaseRunbook.md.
