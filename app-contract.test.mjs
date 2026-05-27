import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const indexHtml = await readFile('index.html', 'utf8');

function containsAll(source, terms) {
  for (const term of terms) {
    assert.ok(source.includes(term), `Expected to find: ${term}`);
  }
}

test('generator prompt requires standalone site pages, contact, footer, and legal content', () => {
  containsAll(indexHtml, [
    'fully functional standalone website',
    'Privacy Policy',
    'Terms of Service',
    'Accessibility',
    'Contact section',
    'contact form',
    'footer'
  ]);
});

test('preview exposes standalone open and demo library controls', () => {
  containsAll(indexHtml, [
    'openStandaloneSite()',
    'saveDemoSite()',
    'openDemoLibrary()',
    'Open Site',
    'Save Demo',
    'Library'
  ]);
});

test('repo includes generated-sites demo library scaffold', () => {
  assert.equal(existsSync('generated-sites/index.html'), true);
  assert.equal(existsSync('generated-sites/README.md'), true);
});

test('inline application script parses successfully', () => {
  const scripts = [...indexHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]);
  assert.ok(scripts.length > 0);
  for (const script of scripts) {
    assert.doesNotThrow(() => new Function(script));
  }
});
