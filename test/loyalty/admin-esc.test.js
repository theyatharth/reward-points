// test/loyalty/admin-esc.test.js
//
// The admin console builds every piece of markup through esc.js (esc and the h`...` tag). This test is the guard:
//  * esc() and h`` behave (pure unit tests);
//  * a scanner reads every JavaScript file of the console and FAILS if any template literal containing HTML is not
//    an h`...` template (so its interpolations are escaped), if an attribute is interpolated unquoted or as an
//    href/src/action, if an inline handler appears, if a string literal holds HTML, or if innerHTML (or any other
//    HTML sink) is used anywhere except esc.js;
//  * the scanner itself is tested against deliberately unsafe sources, so it cannot silently go blind.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { esc, h, mount, isSafe } from '../../web/admin/public/esc.js';
import { problems, scan } from '../helpers/template-scan.js';

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'admin', 'public');
const files = (dir) => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? files(p) : p.endsWith('.js') ? [p] : [];
});
const SOURCES = files(PUBLIC).map((p) => [relative(PUBLIC, p), readFileSync(p, 'utf8')]);

describe('esc and h', () => {
  test('esc escapes & < > " \' ` and nothing else, and is safe on null, undefined and numbers', () => {
    assert.equal(esc('<img src=x onerror="alert(1)">'), '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
    assert.equal(esc(`a&b'c\`d`), 'a&amp;b&#39;c&#96;d');
    assert.equal(esc(null), '');
    assert.equal(esc(undefined), '');
    assert.equal(esc(0), '0');
    assert.equal(esc(12.5), '12.5');
    assert.equal(esc('plain text 123'), 'plain text 123');
    assert.equal(esc('&amp;'), '&amp;amp;', 'already-escaped text is escaped again, never trusted');
  });

  test('h`` escapes every interpolation and keeps the static markup', () => {
    const evil = '<script>alert(1)</script>';
    assert.equal(String(h`<td>${evil}</td>`), '<td>&lt;script&gt;alert(1)&lt;/script&gt;</td>');
    assert.equal(String(h`<a title="${'" onmouseover="x'}">x</a>`), '<a title="&quot; onmouseover=&quot;x">x</a>');
    assert.equal(String(h`<b>${5}</b>${null}${undefined}`), '<b>5</b>');
  });

  test('a fragment made by h`` is not escaped again; arrays of fragments and of plain values work', () => {
    const inner = h`<i>${'<x>'}</i>`;
    assert.equal(String(h`<p>${inner}</p>`), '<p><i>&lt;x&gt;</i></p>');
    assert.equal(String(h`<ul>${['a', 'b<'].map((x) => h`<li>${x}</li>`)}</ul>`), '<ul><li>a</li><li>b&lt;</li></ul>');
    assert.equal(String(h`${['<a>', '<b>']}`), '&lt;a&gt;&lt;b&gt;', 'plain values in an array are escaped');
    assert.equal(isSafe(inner), true);
    assert.equal(isSafe('<i></i>'), false);
  });

  test('a string that merely LOOKS like a fragment is escaped', () => {
    assert.equal(String(h`<p>${'<i>fake</i>'}</p>`), '<p>&lt;i&gt;fake&lt;/i&gt;</p>');
    assert.equal(String(h`<p>${{ html: '<i>fake</i>' }}</p>`), '<p>[object Object]</p>');
  });

  test('mount() takes only fragments', () => {
    const el = { innerHTML: '' };
    mount(el, h`<b>${'<'}</b>`);
    assert.equal(el.innerHTML, '<b>&lt;</b>');
    assert.throws(() => mount(el, '<b>raw</b>'), TypeError);
    assert.throws(() => mount(el, { html: '<b>raw</b>' }), TypeError);
  });
});

describe('the scanner (so it cannot go blind)', () => {
  const bad = (src) => problems('x.js', src);
  test('flags an untagged template with HTML, an untagged tag, and string-built HTML', () => {
    assert.ok(bad('const a = `<td>${x}</td>`;').length >= 1);
    assert.ok(bad('const a = html`<td>${x}</td>`;').length >= 1);
    assert.equal(bad("const a = '<td>' + x + '</td>';").length, 2, 'both pieces');
    assert.equal(bad('const a = "<b>";').length, 1);
  });
  test('flags unquoted and URL-valued attributes and inline handlers inside h``', () => {
    assert.equal(bad('const a = h`<a title=${x}>y</a>`;').length, 1);
    assert.equal(bad('const a = h`<a href="${x}">y</a>`;').length, 1);
    assert.equal(bad("const a = h`<img src='${x}'>`;").length, 1);
    assert.equal(bad('const a = h`<form action="${x}"></form>`;').length, 1);
    assert.equal(bad('const a = h`<button onclick="go()">y</button>`;').length, 1);
  });
  test('accepts the safe forms', () => {
    assert.deepEqual(bad('const a = h`<td title="${x}">${y}</td>`;'), []);
    assert.equal(bad('const a = h`<a href="#/customers/${"1"}">x</a>`;').length, 1, 'even a literal inside an interpolated href is refused: build the path outside');
    assert.deepEqual(bad('const p = `api/customers/${id}`;'), [], 'a plain URL template has no HTML');
    assert.deepEqual(bad('// `<td>${x}</td>` in a comment\nconst a = 1;'), []);
    assert.deepEqual(bad("const ok = h`<p>${h`<i>${x}</i>`}</p>`;"), [], 'nested h templates');
  });
  test('finds templates nested in expressions', () => {
    const { templates } = scan('const a = h`<p>${items.map((i) => `<li>${i}</li>`)}</p>`;');
    assert.deepEqual(templates.map((t) => t.tag).sort(), ['', 'h']);
  });
});

describe('every JavaScript file of the console', () => {
  test('the console has files to check', () => {
    assert.ok(SOURCES.length >= 6, `found ${SOURCES.map(([n]) => n).join(', ')}`);
    assert.ok(SOURCES.some(([n]) => n === 'esc.js') && SOURCES.some(([n]) => n === 'app.js'));
  });

  test('every template that holds HTML is an h`...` template, with quoted, non-URL attributes and no inline handlers', () => {
    const all = SOURCES.filter(([name]) => name !== 'esc.js').flatMap(([name, src]) => problems(name, src));
    assert.deepEqual(all, []);
  });

  test('innerHTML, outerHTML, insertAdjacentHTML, document.write, eval and new Function appear only where allowed', () => {
    for (const [name, src] of SOURCES) {
      for (const sink of ['outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function', 'setAttribute("on', "setAttribute('on", 'javascript:']) {
        assert.ok(!src.includes(sink), `${name} contains ${sink}`);
      }
      if (name !== 'esc.js') assert.ok(!src.includes('innerHTML'), `${name} uses innerHTML (only esc.js may)`);
    }
    assert.equal((SOURCES.find(([n]) => n === 'esc.js')[1].match(/innerHTML/g) || []).length, 1 + 1, 'esc.js: one assignment (plus the comment)');
  });

  test('no file builds a fragment by hand (new Safe, or an object with an html field)', () => {
    for (const [name, src] of SOURCES.filter(([n]) => n !== 'esc.js')) {
      assert.ok(!/new Safe\b/.test(src) && !/\{\s*html\s*:/.test(src), `${name}`);
    }
  });

  test('the HTML page loads scripts only from the console itself and has no inline script, style or handler', () => {
    const html = readFileSync(join(PUBLIC, 'index.html'), 'utf8');
    assert.ok(!/<script(?![^>]*\bsrc=)/i.test(html), 'no inline script');
    assert.ok(!/\sstyle\s*=/i.test(html) && !/<style/i.test(html), 'no inline style');
    assert.ok(!/\son[a-z]+\s*=/i.test(html), 'no inline handler');
    for (const m of html.matchAll(/<script[^>]*\bsrc="([^"]+)"/gi)) assert.match(m[1], /^static\//);
  });
});
