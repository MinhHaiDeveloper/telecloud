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
// native DSD: tc-asio.exe is built from source (it is not in git) and packed next to mpv.exe
const asioExe = path.join(ROOT, 'native', 'asio', 'bin', 'tc-asio.exe');
try {
  execSync('cmd /c native\\asio\\build.cmd', { cwd: ROOT, stdio: 'inherit' });
} catch {
  if (!fs.existsSync(asioExe)) {
    console.error('tc-asio.exe could not be built: install the Visual Studio C++ build tools (x64).');
    process.exit(1);
  }
  console.warn('tc-asio.exe could not be rebuilt; packing the one already built.');
}
execSync('npx vite build', { cwd: ROOT, stdio: 'inherit' });
execSync('npx electron-builder --win --publish never', { cwd: ROOT, stdio: 'inherit' });

const name = `TeleCloud-Setup-${version}.exe`;
if (!fs.existsSync(path.join(out, name))) { console.error('No installer was produced.'); process.exit(1); }
fs.mkdirSync(target, { recursive: true });
// the installer plus what auto-update reads: the channel file (latest.yml / beta.yml) and the blockmap
const upload = fs.readdirSync(out).filter(f => f === name || f === `${name}.blockmap` || (f.endsWith('.yml') && !f.startsWith('builder-')));
upload.forEach(f => fs.copyFileSync(path.join(out, f), path.join(target, f)));
const sha = require('crypto').createHash('sha256').update(fs.readFileSync(path.join(target, name))).digest('hex');
fs.writeFileSync(path.join(target, 'SHA256.txt'), `${sha}  ${name}\n`);
const mb = (fs.statSync(path.join(target, name)).size / 1048576).toFixed(1);
console.log(`\n${channel} ${version} (${mb} MB) in ${path.relative(ROOT, target)}:\n  ${upload.join('\n  ')}\nSHA-256 ${sha}\nUpload all of these (not SHA256.txt) to the GitHub release.`);
