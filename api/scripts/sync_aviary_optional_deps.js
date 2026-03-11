#!/usr/bin/env node

const fs = require('fs');
const path = require('path');

const apiRoot = path.resolve(__dirname, '..');
const apiPkgPath = path.join(apiRoot, 'package.json');
const aviaryPkgPath = path.resolve(apiRoot, '../aviary/package.json');

if (!fs.existsSync(apiPkgPath)) {
  console.error(`[aviary-sync] api package.json not found: ${apiPkgPath}`);
  process.exit(1);
}

if (!fs.existsSync(aviaryPkgPath)) {
  console.error(`[aviary-sync] aviary package.json not found: ${aviaryPkgPath}`);
  process.exit(1);
}

const apiPkg = JSON.parse(fs.readFileSync(apiPkgPath, 'utf8'));
const aviaryPkg = JSON.parse(fs.readFileSync(aviaryPkgPath, 'utf8'));

const aviaryDeps = Object.entries(aviaryPkg.dependencies || {})
  .filter(([name]) => String(name).startsWith('@aviary-ai/'));

const nextOptional = { ...(apiPkg.optionalDependencies || {}) };
let changed = 0;

for (const [name, version] of aviaryDeps) {
  if (nextOptional[name] !== version) {
    nextOptional[name] = version;
    changed += 1;
  }
}

const sortedOptional = Object.fromEntries(
  Object.entries(nextOptional).sort(([a], [b]) => a.localeCompare(b)),
);

apiPkg.optionalDependencies = sortedOptional;

fs.writeFileSync(apiPkgPath, `${JSON.stringify(apiPkg, null, 2)}\n`, 'utf8');

console.log(`[aviary-sync] linked ${aviaryDeps.length} packages from aviary into api optionalDependencies`);
console.log(`[aviary-sync] updated entries: ${changed}`);
