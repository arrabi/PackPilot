# App versions and build identity

Use the root `package.json` version as the single app version. Start at **0.1.0** for the pilot. Use SemVer: patch releases fix bugs (`0.1.1`), minor releases add features (`0.2.0`), and major releases mark breaking changes after the stable `1.0.0` launch. Bump the version for an intended release, rather than every commit or staging deployment.

To prepare a version bump, run `npm version patch --no-git-tag-version` (or `minor`), which updates both package files. Commit the change and follow the normal checks, PR and staging process. Production still requires owner approval of the exact tested commit.

The shared app footer displays environment, app version, the first 12 characters of the source commit, and the build date/time in America/Los_Angeles with its timezone. The timestamp is captured once during the Vite build, not when a visitor opens the page. Public HTML metadata (`pack99-version`, `pack99-release`, `pack99-built-at`, `pack99-environment`) records the same identity.

Compare **commit IDs** to tell whether staging and production use the same source. They may share a SemVer version but have different commits while work is being integrated. Build timestamps may differ when the same approved source is built for each environment. Existing production builds gain this footer when the change is promoted through the approved release workflow.
