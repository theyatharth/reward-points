// test/helpers/template-scan.js
//
// A small JavaScript scanner used by the admin-console tests: it finds every template literal (with its tag, its
// static parts and its nested expressions) and every plain string literal in a source file, skipping comments.
// It is deliberately simple (no regex-literal support): the console's own files must not need it, and
// a file that confuses it fails the test loudly rather than slipping through.

/** @returns {{ templates: Array<{ tag: string, statics: string[], line: number }>, strings: Array<{ value: string, line: number }> }} */
export function scan(src) {
  const templates = [];
  const strings = [];
  const lineAt = (i) => src.slice(0, i).split('\n').length;

  function code(i, untilBrace) {
    let depth = 0;
    while (i < src.length) {
      const c = src[i];
      const n = src[i + 1];
      if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
      if (c === '/' && n === '*') { i = src.indexOf('*/', i + 2); if (i < 0) throw new Error('unterminated comment'); i += 2; continue; }
      if (c === '"' || c === "'") {
        const start = i;
        i++;
        let value = '';
        while (i < src.length && src[i] !== c) {
          if (src[i] === '\\') { value += src[i + 1]; i += 2; continue; }
          if (src[i] === '\n') throw new Error(`unterminated string at line ${lineAt(start)}`);
          value += src[i++];
        }
        strings.push({ value, line: lineAt(start) });
        i++;
        continue;
      }
      if (c === '`') { i = template(i); continue; }
      if (untilBrace) {
        if (c === '{') depth++;
        if (c === '}') { if (depth === 0) return i + 1; depth--; }
      }
      i++;
    }
    return i;
  }

  function template(i) {
    const start = i;
    let tagEnd = i;
    let tagStart = tagEnd;
    while (tagStart > 0 && /[A-Za-z0-9_$.]/.test(src[tagStart - 1])) tagStart--;
    const tag = src.slice(tagStart, tagEnd);
    const statics = [''];
    i++;
    while (i < src.length && src[i] !== '`') {
      if (src[i] === '\\') { statics[statics.length - 1] += src[i] + (src[i + 1] ?? ''); i += 2; continue; }
      if (src[i] === '$' && src[i + 1] === '{') { i = code(i + 2, true); statics.push(''); continue; }
      statics[statics.length - 1] += src[i++];
    }
    if (i >= src.length) throw new Error(`unterminated template at line ${lineAt(start)}`);
    templates.push({ tag, statics, line: lineAt(start) });
    return i + 1;
  }

  code(0, false);
  return { templates, strings };
}

const HTML = /<\/?[a-zA-Z]/;

/**
 * The rules for a console source file (everything except esc.js itself). Returns a list of problems.
 *  1. a template literal containing HTML must be tagged h
 *  2. inside h templates: no unquoted attribute interpolation (`=${`), no interpolated href/src/action, no on*= handler
 *  3. a plain template with interpolations must not contain < or >
 *  4. no plain string literal containing HTML
 */
export function problems(file, src) {
  const out = [];
  const { templates, strings } = scan(src);
  for (const t of templates) {
    const whole = t.statics.join('');
    const where = `${file}:${t.line}`;
    if (HTML.test(whole) && t.tag !== 'h') out.push(`${where}: a template with HTML is not an h\`...\` template (tag "${t.tag}")`);
    if (t.tag === 'h') {
      t.statics.slice(0, -1).forEach((s, i) => {
        if (/=\s*$/.test(s)) out.push(`${where}: attribute interpolated without quotes after "...${s.slice(-20)}"`);
        if (/\b(href|src|action|formaction|srcset|style)\s*=\s*["'][^"']*$/i.test(s)) out.push(`${where}: an interpolated ${s.match(/(href|src|action|formaction|srcset|style)\s*=\s*["'][^"']*$/i)[1]} attribute`);
        void i;
      });
      if (/\bon[a-z]+\s*=/i.test(whole)) out.push(`${where}: an inline event handler`);
    } else if (t.statics.length > 1 && /[<>]/.test(whole)) {
      out.push(`${where}: an interpolated plain template contains < or >`);
    }
  }
  for (const s of strings) if (HTML.test(s.value)) out.push(`${file}:${s.line}: a string literal contains HTML: ${JSON.stringify(s.value.slice(0, 40))}`);
  return out;
}
