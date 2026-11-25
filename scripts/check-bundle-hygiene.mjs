#!/usr/bin/env node
// Guards against Dash-internal content reaching a bundle that leaves Dash.
//
// Background: the marketplace distribution is downloaded by other
// organisations. Two directories here are specific to Dash — docs/ names the
// Jira site, real issue keys and a named individual in its incident history, and
// recovery/ carries a script hard-coded with the issue keys hit by the August
// 2026 mass deletion.
//
// There is no supported way to exclude files from a Forge bundle. `.forgeignore`
// looks like the answer and is not: the CLI changelog records "Remove unused
// .forgeignore template feature", so it is inert. The documented options are
// `app.package.extraFiles` (which adds, not removes) and the Preview manual
// bundler.
//
// What actually keeps those directories out is that Forge bundles from entry
// points — the manifest's function handlers and its declared resource paths —
// rather than copying the tree. So the protection is simply that nothing
// reachable references them. This script asserts exactly that, and nothing more.
//
// WHAT THIS PROVES: no reachable source file references docs/ or recovery/, and
// no declared resource path contains them.
// WHAT IT DOES NOT PROVE: what the Forge bundler actually uploads. Only
// `forge build --inspect` settles that, and it needs an authenticated CLI.
// Run it once before the first marketplace submission.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Directories that must never be reachable from bundled code. */
const INTERNAL_DIRS = ['docs', 'recovery'];

/** Trees the Forge bundler can actually reach. */
const REACHABLE = ['src', 'static'];

const problems = [];

function walk(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

/* 1. No reachable source file may reference an internal directory. */

const sourceFiles = REACHABLE.flatMap((dir) => walk(path.join(ROOT, dir))).filter((file) =>
  /\.(m?js|cjs|ts|html|css|json)$/.test(file),
);

for (const file of sourceFiles) {
  // Generated bundles inline their sources; checking them would flag the very
  // comments that explain this rule. The inputs are what matter.
  if (/static[\\/](admin|panel)[\\/]main\.js(\.map)?$/.test(file)) continue;

  const text = fs.readFileSync(file, 'utf8');
  for (const dir of INTERNAL_DIRS) {
    const pattern = new RegExp(`(from|require|import|src|href)\\s*\\(?['"\`][^'"\`]*\\b${dir}/`, 'i');
    if (pattern.test(text)) {
      problems.push(`${path.relative(ROOT, file)} appears to reference ${dir}/`);
    }
  }
}

/* 2. No declared resource path may contain an internal directory. */

const manifestPath = path.join(ROOT, 'manifests', 'manifest.template.yml');
const manifest = fs.readFileSync(manifestPath, 'utf8');
const resourcePaths = [...manifest.matchAll(/^\s*path:\s*(\S+)\s*$/gm)].map((match) => match[1]);

if (resourcePaths.length === 0) {
  problems.push('no resource paths found in the manifest template — has its shape changed?');
}

for (const resource of resourcePaths) {
  for (const dir of INTERNAL_DIRS) {
    if (resource === dir || resource.startsWith(`${dir}/`) || resource.includes(`/${dir}/`)) {
      problems.push(`resource path "${resource}" includes the internal directory ${dir}/`);
    }
  }
}

/* 3. The internal directories should still exist where we think they do —
 *    otherwise this check is quietly passing against nothing. */

for (const dir of INTERNAL_DIRS) {
  if (!fs.existsSync(path.join(ROOT, dir))) {
    console.warn(`  note: ${dir}/ does not exist; nothing to protect`);
  }
}

/* ------------------------------------------------------------------ report -- */

if (problems.length > 0) {
  console.error('\nbundle hygiene: FAILED\n');
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error(
    '\nSomething reachable by the Forge bundler now points at Dash-internal\n' +
      'content. Fix the reference before deploying the marketplace build.\n',
  );
  process.exit(1);
}

console.log('bundle hygiene: ok');
console.log(`  checked ${sourceFiles.length} source files under ${REACHABLE.join(', ')}/`);
console.log(`  resource paths: ${resourcePaths.join(', ')}`);
console.log(`  no reachable reference to: ${INTERNAL_DIRS.map((d) => `${d}/`).join(', ')}`);
console.log('  (static check only — run `forge build --inspect` once to confirm the real bundle)');
