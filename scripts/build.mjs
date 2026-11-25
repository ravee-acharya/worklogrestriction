// Bundles the two Custom UI frontends into their static/ resource folders.
//
// Only JS is bundled. index.html and styles.css live directly in static/ and are
// shipped as written, which keeps the CSS readable and diffable.
import * as esbuild from 'esbuild';

const targets = [
  { in: 'src/frontend/admin/main.js', out: 'static/admin/main.js' },
  { in: 'src/frontend/panel/main.js', out: 'static/panel/main.js' },
];

const watch = process.argv.includes('--watch');
/**
 * Preview mode swaps @forge/bridge for a fixture module and writes into
 * preview/, so both surfaces can be opened in an ordinary browser. Nothing in
 * preview/ is shipped — the resource paths in manifest.yml point at static/.
 */
const preview = process.argv.includes('--preview');

const previewTargets = [
  { in: 'src/frontend/admin/main.js', out: 'preview/admin/main.js' },
  { in: 'src/frontend/panel/main.js', out: 'preview/panel/main.js' },
];

const options = (target) => ({
  entryPoints: [target.in],
  outfile: target.out,
  bundle: true,
  format: 'iife',
  target: ['chrome100', 'firefox100', 'safari15', 'edge100'],
  minify: !watch && !preview,
  sourcemap: watch || preview,
  logLevel: 'info',
  ...(preview
    ? { alias: { '@forge/bridge': './src/frontend/preview/bridge-mock.js' } }
    : {}),
});

for (const target of preview ? previewTargets : targets) {
  if (watch) {
    const ctx = await esbuild.context(options(target));
    await ctx.watch();
  } else {
    await esbuild.build(options(target));
  }
}

if (watch) {
  console.log('watching for changes…');
} else {
  console.log('build complete');
}
