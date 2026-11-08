console.error('Production website releases run through GitHub Actions after merging to main.');
console.error('Commit and push your task branch, open a pull request, and follow documentation/release-process.md.');
console.error('Use npm run build:auth for a local build. No deployment was attempted.');
process.exitCode = 1;
