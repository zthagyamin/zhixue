import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../app/tokens.css', import.meta.url), 'utf8');

function palette(selector) {
  const block = source.match(new RegExp(`${selector}\\s*\\{([\\s\\S]*?)\\n\\}`))[1];
  const colors = [...block.matchAll(/--(study-[\w-]+):\s*(#[\da-f]{3,6});/gi)];
  return Object.fromEntries(colors.map(([, name, value]) => [name, value]));
}

function luminance(hex) {
  const color = hex.slice(1);
  const expanded = color.length === 3 ? [...color].map(c => c + c).join('') : color;
  const channels = [0, 2, 4]
    .map(offset => parseInt(expanded.slice(offset, offset + 2), 16) / 255)
    .map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4);
  return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
}

function contrast(a, b) {
  const x = luminance(a), y = luminance(b);
  return (Math.max(x, y) + .05) / (Math.min(x, y) + .05);
}

for (const [name, selector] of [['light', ':root'], ['dark', '\\.dark']]) {
  test(`${name} reading, actions and input boundaries retain measurable contrast`, () => {
    const p = {...palette(':root'), ...palette(selector)};
    const checks = [];
    for (const text of ['study-ink', 'study-muted', 'study-accent-text']) {
      for (const background of ['study-surface', 'study-surface-2', 'study-paper']) {
        checks.push([text, background, 4.5]);
      }
    }
    for (const token of ['study-code-keyword', 'study-code-function', 'study-code-literal']) {
      checks.push([token, 'study-surface-2', 4.5]);
    }
    checks.push(
      ['study-accent-text', 'study-accent-soft', 4.5],
      ['study-on-accent', 'study-accent', 4.5],
      ['study-on-accent', 'study-accent-hover', 4.5],
      ['study-hero-ink', 'study-hero-bg', 4.5],
      ['study-hero-muted', 'study-hero-bg', 4.5],
      ['study-control-border', 'study-surface', 3],
    );
    for (const [text, background, min] of checks) {
      const ratio = contrast(p[text], p[background]);
      assert.ok(ratio >= min, `${name} ${text}/${background}: ${ratio.toFixed(2)} < ${min}`);
    }
  });
}

test('homepage code styles bind to the palette checked above', () => {
  const landing = readFileSync(new URL('../app/landing-hierarchy.css', import.meta.url), 'utf8');
  for (const token of ['study-code-keyword', 'study-code-function', 'study-code-literal']) {
    assert.ok(landing.includes(`var(--${token})`), `homepage syntax must use ${token}`);
  }
});
