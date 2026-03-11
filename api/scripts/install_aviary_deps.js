#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const apiRoot = path.resolve(__dirname, '..');
const apiPkgPath = path.join(apiRoot, 'package.json');
const profileArg = process.argv.find((arg) => arg.startsWith('--profile='));
const profile = (profileArg ? profileArg.split('=')[1] : 'core').trim();

if (!fs.existsSync(apiPkgPath)) {
  console.error(`[aviary-install] api package.json not found: ${apiPkgPath}`);
  process.exit(1);
}

if (profile !== 'core' && profile !== 'all') {
  console.error(`[aviary-install] invalid --profile value: ${profile} (expected core|all)`);
  process.exit(1);
}

if (!process.env.GITHUB_TOKEN) {
  console.error('[aviary-install] GITHUB_TOKEN is missing. Export it before install.');
  process.exit(2);
}

const apiPkg = JSON.parse(fs.readFileSync(apiPkgPath, 'utf8'));
const optionalDeps = apiPkg.optionalDependencies || {};
const isMysqlAdapter = (name) => String(name).endsWith('-mysql');

const targets = Object.keys(optionalDeps)
  .filter((name) => String(name).startsWith('@aviary-ai/'))
  .filter((name) => (profile === 'core' ? !isMysqlAdapter(name) : true))
  .sort((a, b) => a.localeCompare(b))
  .map((name) => `${name}@${optionalDeps[name]}`);

if (!targets.length) {
  console.log(`[aviary-install] no aviary packages found for profile=${profile}`);
  process.exit(0);
}

console.log(`[aviary-install] profile=${profile}, packages=${targets.length}`);
console.log(`[aviary-install] running: pnpm add --save-optional ${targets.join(' ')}`);

const result = spawnSync('pnpm', ['add', '--save-optional', ...targets], {
  cwd: apiRoot,
  env: process.env,
  stdio: 'inherit',
});

if (result.error) {
  console.error(`[aviary-install] failed to run pnpm: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status == null ? 1 : result.status);
