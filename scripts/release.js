// Build an installer for one channel and file it under <channel>/telecloud-<version>/
//   npm run build:beta     (version must be a pre-release, e.g. 1.0.0-beta.2)
//   npm run build:release  (version must be a plain release, e.g. 1.0.0)
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const channel = process.argv[2];
if (!['beta', 'release'].includes(channel)) {
  console.error('Usage: node scripts/release.js <beta|release>');
  process.exit(1);
}
const { version, build } = require(path.join(ROOT, 'package.json'));
const pre = version.includes('-');
if (channel === 'beta' && !pre) {
  console.error(`Version ${version} is not a pre-release. Set something like "${version}-beta.1" in package.json first.`);
  process.exit(1);
}
if (channel === 'release' && pre) {
  console.error(`Version ${version} is a pre-release. Set a plain version (e.g. "${version.split('-')[0]}") in package.json first.`);
  process.exit(1);
}

const target = path.join(ROOT, channel, `telecloud-${version}`);
if (fs.existsSync(target)) {
  console.error(`${path.relative(ROOT, target)} already exists. Bump the version in package.json for a new build.`);
  process.exit(1);
}

const out = path.join(ROOT, build.directories.output);
fs.rmSync(out, { recursive: true, force: true });
execSync('npx vite build', { cwd: ROOT, stdio: 'inherit' });
execSync('npx electron-builder --win', { cwd: ROOT, stdio: 'inherit' });

const exe = fs.readdirSync(out).find(f => f.endsWith('.exe'));
if (!exe) { console.error('No installer was produced.'); process.exit(1); }
fs.mkdirSync(target, { recursive: true });
const name = `TeleCloud-Setup-${version}.exe`;
fs.copyFileSync(path.join(out, exe), path.join(target, name));
const sha = require('crypto').createHash('sha256').update(fs.readFileSync(path.join(target, name))).digest('hex');
fs.writeFileSync(path.join(target, 'SHA256.txt'), `${sha}  ${name}\n`);
const mb = (fs.statSync(path.join(target, name)).size / 1048576).toFixed(1);
console.log(`\n${channel} ${version}: ${path.relative(ROOT, path.join(target, name))} (${mb} MB)\nSHA-256 ${sha}`);
