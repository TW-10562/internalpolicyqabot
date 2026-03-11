const NODE_VERSION = String(process.versions?.node || process.version || '').replace(/^v/, '');

const parseVersion = (value) => {
  const parts = String(value || '0.0.0')
    .split('.')
    .map((v) => Number.parseInt(v, 10));
  return [
    Number.isFinite(parts[0]) ? parts[0] : 0,
    Number.isFinite(parts[1]) ? parts[1] : 0,
    Number.isFinite(parts[2]) ? parts[2] : 0,
  ];
};

const compareVersion = (a, b) => {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] > b[i]) return 1;
    if (a[i] < b[i]) return -1;
  }
  return 0;
};

const isSupportedNode = (version) => {
  const [major] = version;
  if (major === 20) return compareVersion(version, [20, 19, 0]) >= 0;
  if (major === 22) return compareVersion(version, [22, 12, 0]) >= 0;
  if (major > 22) return true;
  return false;
};

const current = parseVersion(NODE_VERSION);
if (!isSupportedNode(current)) {
  const currentLabel = `${current[0]}.${current[1]}.${current[2]}`;
  console.error('');
  console.error(`[NodeVersionError] Detected Node.js ${currentLabel}.`);
  console.error('[NodeVersionError] This UI requires Node.js 20.19+ or 22.12+ (Vite requirement).');
  console.error('[NodeVersionError] Use one of the following before running npm scripts:');
  console.error('  1) cd ui-2 && ./dev.sh');
  console.error('  2) nvm use 22.22.0');
  console.error('');
  process.exit(1);
}
