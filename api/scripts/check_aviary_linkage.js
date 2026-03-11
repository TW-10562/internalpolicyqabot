#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const Module = require('module');

const apiRoot = path.resolve(__dirname, '..');
const apiPkgPath = path.join(apiRoot, 'package.json');
const strictMode = process.argv.includes('--strict');
const profileArg = process.argv.find((arg) => arg.startsWith('--profile='));
const profile = (profileArg ? profileArg.split('=')[1] : 'all').trim();

if (!fs.existsSync(apiPkgPath)) {
  console.error(`[aviary-check] api package.json not found: ${apiPkgPath}`);
  process.exit(1);
}

if (profile !== 'all' && profile !== 'core') {
  console.error(`[aviary-check] invalid --profile value: ${profile} (expected core|all)`);
  process.exit(1);
}

const apiPkg = JSON.parse(fs.readFileSync(apiPkgPath, 'utf8'));
const optionalDeps = apiPkg.optionalDependencies || {};
const isMysqlAdapter = (name) => String(name).endsWith('-mysql');
const aviaryPkgs = Object.keys(optionalDeps)
  .filter((name) => String(name).startsWith('@aviary-ai/'))
  .filter((name) => (profile === 'core' ? !isMysqlAdapter(name) : true))
  .sort((a, b) => a.localeCompare(b));

const requireFromApi = Module.createRequire(path.join(apiRoot, 'package.json'));
const rows = [];

for (const name of aviaryPkgs) {
  try {
    const pkgJsonPath = requireFromApi.resolve(`${name}/package.json`);
    const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
    rows.push({
      name,
      expected: optionalDeps[name],
      installed: true,
      installedVersion: pkgJson.version || null,
    });
  } catch {
    rows.push({
      name,
      expected: optionalDeps[name],
      installed: false,
      installedVersion: null,
    });
  }
}

const installedCount = rows.filter((row) => row.installed).length;
const missingRows = rows.filter((row) => !row.installed);

console.log(`[aviary-check] profile=${profile}`);
console.log(`[aviary-check] optional packages tracked: ${rows.length}`);
console.log(`[aviary-check] installed: ${installedCount}, missing: ${missingRows.length}`);

for (const row of rows) {
  const status = row.installed ? 'OK' : 'MISSING';
  const version = row.installedVersion || '-';
  console.log(`${status}\t${row.name}\texpected=${row.expected}\tinstalled=${version}`);
}

if (strictMode && missingRows.length > 0) {
  process.exit(1);
}
