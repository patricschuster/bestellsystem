// scripts/check-version.js
// Waechter: package.json ist die einzige Versionsquelle. Faellt beim Image-Build
// auf, sobald irgendwo wieder eine Versionsnummer hartcodiert wird.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

// Was durchsucht wird (package.json selbst ist die Quelle und bleibt aussen vor).
const ROOTS = ['server.js', 'Dockerfile', 'src', 'public', 'docker-compose.yml', 'docker-compose.pi.yml'];
const SKIP_DIRS = new Set(['node_modules', 'data', 'certs', '.git', 'assets', 'fonts', 'icons']);
const EXT = new Set(['.js', '.json', '.html', '.css', '.yml', '.webmanifest', '']);

const SEMVER = /\bv?\d+\.\d+\.\d+\b/g;
const ALLOW = /check-version:allow/;   // Opt-out pro Zeile, falls mal noetig

function* files(p) {
  const st = fs.statSync(p, { throwIfNoEntry: false });
  if (!st) return;
  if (st.isDirectory()) {
    for (const e of fs.readdirSync(p)) {
      if (SKIP_DIRS.has(e)) continue;
      yield* files(path.join(p, e));
    }
  } else if (EXT.has(path.extname(p))) {
    yield p;
  }
}

const hits = [];
for (const r of ROOTS) {
  for (const f of files(path.join(root, r))) {
    const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
    lines.forEach((line, i) => {
      if (ALLOW.test(line)) return;
      const m = line.match(SEMVER);
      if (m) hits.push({ file: path.relative(root, f).split(path.sep).join('/'), line: i + 1, found: m.join(', '), text: line.trim().slice(0, 100) });
    });
  }
}

if (hits.length) {
  console.error(`\nFEHLER: hartcodierte Versionsnummern gefunden (Quelle ist package.json = ${version}):\n`);
  for (const h of hits) console.error(`  ${h.file}:${h.line}  ->  ${h.found}\n      ${h.text}`);
  console.error(`\nEntweder die Stelle von APP_VERSION / window.__APP_VERSION__ ableiten,`);
  console.error(`oder die Zeile mit "check-version:allow" kommentieren.\n`);
  process.exit(1);
}
console.log(`Versionscheck ok - einzige Quelle: package.json (${version})`);
