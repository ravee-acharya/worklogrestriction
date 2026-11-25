// Mirrors the shipped HTML and CSS into preview/, so the preview renders the
// exact same markup and styles the deployed app uses.
import { mkdir, copyFile } from 'node:fs/promises';

for (const surface of ['admin', 'panel']) {
  await mkdir(new URL(`../preview/${surface}/`, import.meta.url), { recursive: true });
  for (const file of ['index.html', 'styles.css']) {
    await copyFile(
      new URL(`../static/${surface}/${file}`, import.meta.url),
      new URL(`../preview/${surface}/${file}`, import.meta.url),
    );
  }
}

console.log('preview assets copied');
