#!/usr/bin/env node

/**
 * Maintenance Notification Controller
 *
 * This script activates / deactivates the maintenance banner that users see.
 * It works by reading and writing to api/data/maintenance.json — a config file
 * that the API serves and the UI polls.
 *
 * ─── Quick usage ─────────────────────────────────────────────────────
 *
 *   node notify.js on              Activate banner using existing config
 *   node notify.js off             Deactivate banner
 *   node notify.js status          Show current config
 *   node notify.js edit            Open config file path for manual editing
 *
 * ─── Advanced: override from CLI ─────────────────────────────────────
 *
 *   node notify.js on --type update
 *   node notify.js on --type maintenance
 *   node notify.js on --type incident
 *   node notify.js on --time "10 minutes" --time-ja "約10分"
 *   node notify.js on --no-dismiss          (user cannot close the banner)
 *
 * ─── The config file ─────────────────────────────────────────────────
 *
 *   api/data/maintenance.json
 *
 *   Edit this file directly to customise title, message (EN/JA),
 *   estimated time, type, and dismissability. Then run:
 *     node notify.js on
 */

const fs = require('fs');
const path = require('path');

const FILE = path.resolve(__dirname, 'api/data/maintenance.json');

// ── Helpers ──────────────────────────────────────────────────────────
function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf-8'));
  } catch {
    return { active: false };
  }
}

function writeConfig(data) {
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2) + '\n');
}

function printConfig(cfg) {
  const status = cfg.active ? '🟢 ACTIVE' : '⚪ INACTIVE';
  console.log('');
  console.log(`   Status:  ${status}`);
  console.log(`   Type:    ${cfg.type || 'maintenance'}`);
  console.log(`   Title:   ${cfg.title?.en || '—'}`);
  console.log(`           ${cfg.title?.ja || '—'}`);
  console.log(`   Message: ${cfg.message?.en || '—'}`);
  console.log(`           ${cfg.message?.ja || '—'}`);
  if (cfg.estimatedTime?.en || cfg.estimatedTime?.ja) {
    console.log(`   ETA:     ${cfg.estimatedTime?.en || '—'} / ${cfg.estimatedTime?.ja || '—'}`);
  }
  console.log(`   Dismiss: ${cfg.allowDismiss !== false ? 'yes' : 'no (locked on screen)'}`);
  if (cfg.activatedAt) {
    console.log(`   Since:   ${cfg.activatedAt}`);
  }
  console.log('');
}

// ── Parse args ───────────────────────────────────────────────────────
const args = process.argv.slice(2);
const command = (args[0] || '').toLowerCase();

function getFlag(name) {
  const idx = args.indexOf(name);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : null;
}

// ── Commands ─────────────────────────────────────────────────────────
if (command === 'off' || command === '--clear' || command === '-c') {
  const cfg = readConfig();
  cfg.active = false;
  cfg.activatedAt = '';
  writeConfig(cfg);
  console.log('');
  console.log('✅ Maintenance banner deactivated.');
  console.log('   Users will no longer see the notice.');
  console.log('');
  process.exit(0);
}

if (command === 'status' || command === 'info') {
  const cfg = readConfig();
  console.log('\n  ── Maintenance Banner Config ──');
  printConfig(cfg);
  console.log(`  Config file: ${FILE}`);
  console.log('');
  process.exit(0);
}

if (command === 'edit') {
  console.log('');
  console.log(`  Open this file in your editor:`);
  console.log(`  ${FILE}`);
  console.log('');
  console.log('  After editing, run: node notify.js on');
  console.log('');
  process.exit(0);
}

if (command === 'on') {
  const cfg = readConfig();
  cfg.active = true;
  cfg.activatedAt = new Date().toISOString();

  // CLI overrides (optional)
  const typeOverride = getFlag('--type');
  if (typeOverride) cfg.type = typeOverride;

  const timeEn = getFlag('--time');
  if (timeEn) {
    cfg.estimatedTime = cfg.estimatedTime || {};
    cfg.estimatedTime.en = timeEn;
  }
  const timeJa = getFlag('--time-ja');
  if (timeJa) {
    cfg.estimatedTime = cfg.estimatedTime || {};
    cfg.estimatedTime.ja = timeJa;
  }

  if (args.includes('--no-dismiss')) {
    cfg.allowDismiss = false;
  }
  if (args.includes('--dismiss')) {
    cfg.allowDismiss = true;
  }

  writeConfig(cfg);

  console.log('\n  🔔 Maintenance banner ACTIVATED!\n');
  printConfig(cfg);
  console.log('  Users will see this on their next page load / within 30 seconds.');
  console.log('  Run "node notify.js off" when you are done.\n');
  process.exit(0);
}

// ── Help / default ───────────────────────────────────────────────────
console.log(`
  Maintenance Notification Controller
  ────────────────────────────────────

  Usage:
    node notify.js on                Activate the banner
    node notify.js off               Deactivate the banner
    node notify.js status            Show current config
    node notify.js edit              Show config file path

  Options (with "on"):
    --type <maintenance|update|incident>
    --time "10 minutes"    --time-ja "約10分"
    --no-dismiss           Prevent users from closing the banner
    --dismiss              Allow users to close (default)

  Config file:
    ${FILE}

  Edit the config file to customise title, message, and type.
  Then just run: node notify.js on
`);
