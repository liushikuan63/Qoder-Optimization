'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const core = require('./convention-core.cjs');
const i18n = require('./convention-i18n.cjs');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'convention-i18n-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (name, value) => { fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true }); fs.writeFileSync(path.join(root, name), typeof value === 'string' ? value : JSON.stringify(value)); };
  write('src/page.html', '<button data-i18n="save">Save</button>');
  write('locales/en.json', { save: 'Save', welcome: 'Hello {{name}}' }); write('locales/zh.json', { save: '保存', welcome: '你好 {{name}}' });
  const input = { schema: 1, projectRoot: root, taskId: 't', sourceRoots: ['src'], catalog: { defaultLocale: 'en', requiredLocales: ['en', 'zh'], defaultNamespace: 'translation', namespaces: { translation: { en: 'locales/en.json', zh: 'locales/zh.json' } } } };
  const run = authority => i18n.check(input, authority);
  return { root, write, input, run };
}
test('HTML and JSON catalogs are parsed without executing resource code', t => {
  const f = fixture(t), r = f.run();
  assert.equal(r.status, 'PASS'); assert.equal(r.parsed, 1); assert.equal(r.references, 1);
  assert.match(r.limits, /not verified/);
});
test('English, Chinese, attributes and accessibility labels are user-visible', t => {
  const f = fixture(t); f.write('src/page.html', '<button title="Save" aria-label="保存">Open</button>');
  const r = f.run(); assert.equal(r.status, 'FAIL'); assert.equal(r.issues.length, 3);
});
test('comments, scripts metadata and internal strings do not count as visible text', t => {
  const f = fixture(t); f.write('src/page.html', '<!-- internal English --><style>.x{color:red}</style><button data-i18n="save">Save</button>');
  f.write('src/code.js', "const debugMessage = 'internal English'; // 中文内部注释\n");
  assert.equal(f.run().status, 'PASS');
});
test('i18next imports and aliases bind real translation calls', t => {
  const f = fixture(t); f.write('src/code.js', "import {t as tr} from 'i18next';\nnode.textContent = tr('welcome', {name: 'User'});\n");
  const r = f.run(); assert.equal(r.status, 'PASS'); assert.equal(r.references, 2);
});
test('namespace and CommonJS bindings are supported without importing the project', t => {
  const f = fixture(t); f.write('src/code.cjs', "const i18next = require('i18next');\nnode.textContent = i18next.t('save');\n");
  assert.equal(f.run().status, 'PASS');
});
test('a same-name function and shadowed translation parameters are not accepted', t => {
  const f = fixture(t); f.write('src/code.js', "function t(key) {return key;}\nnode.textContent = t('save');\n");
  assert.equal(f.run().status, 'UNVERIFIED');
  f.write('src/code.js', "import {t} from 'i18next';\nfunction render(t) {node.textContent = t('save');}\n");
  assert.equal(f.run().status, 'UNVERIFIED');
});
for (const statement of [
  "for (let t = custom; flag; ) node.textContent = t('save');",
  "for (const t of callbacks) { node.textContent = t('save'); }",
  "for (const t in callbacks) { node.textContent = t('save'); }",
  "for (const {t} of callbacks) { node.textContent = t('save'); }",
  "for (const [t] of callbacks) { node.textContent = t('save'); }",
  "for (let t = custom; node.textContent = t('save'); ) {}",
  "switch (kind) { case 1: let t = custom; break; default: node.textContent = t('save'); }",
]) {
  test('B02 lexical shadows cannot masquerade as translators: ' + statement, t => {
    const f = fixture(t);
    f.write('src/code.js', "import {t} from 'i18next'; " + statement + " node.textContent = t('save');");
    const r = f.run();
    assert.equal(r.status, 'UNVERIFIED');
    assert.equal(r.references, 2);
    assert.ok(r.unknown.some(i => i.code === 'DYNAMIC_VISIBLE_TEXT'));
  });
}
test('B02 loop literals and namespace shadows keep their own bindings', t => {
  const f = fixture(t);
  f.write('src/code.js', "import {t} from 'i18next'; for (let t = 'Hardcoded'; flag; ) node.textContent = t; node.textContent = t('save');");
  assert.equal(f.run().status, 'FAIL');
  f.write('src/code.js', "import i18next from 'i18next'; for (const i18next of objects) node.textContent = i18next.t('save'); node.textContent = i18next.t('save');");
  assert.equal(f.run().status, 'UNVERIFIED');
  assert.equal(f.run().references, 2);
});
test('B02 unshadowed loop translators and outer switch discriminants remain valid', t => {
  const f = fixture(t);
  f.write('src/code.js', "import {t} from 'i18next'; for (let i = 0; i < 1; i++) node.textContent = t('save'); for (const item of items) node.textContent = t('save'); for (const key in items) node.textContent = t('save'); switch (t('save')) { case 'Save': let t = custom; break; } node.textContent = t('save');");
  const r = f.run();
  assert.equal(r.status, 'PASS');
  assert.equal(r.references, 6);
});
for (const [declaration, name, call] of [['i18next', 'i18next', "i18next.t('save')"], ['{t}', 't', "t('save')"]]) {
  for (const inFunction of [false, true]) {
    test('B02 switch var redeclarations preserve reassignment detection: ' + name + '/' + inFunction, t => {
      const f = fixture(t);
      const source = "var " + declaration + " = require('i18next'); switch (kind) { case 1: var " + name + '; ' + name + " = custom; break; } node.textContent = " + call + ';';
      f.write('src/code.cjs', inFunction ? 'function render() {' + source + '}' : source);
      const r = f.run();
      assert.equal(r.status, 'UNVERIFIED');
      assert.ok(r.unknown.some(i => i.code === 'TRANSLATOR_REASSIGNED'));
    });
  }
}
test('B02 switch var without reassignment retains the outer translator', t => {
  const f = fixture(t);
  f.write('src/code.cjs', "var i18next = require('i18next'); switch (kind) { case 1: var i18next; node.textContent = i18next.t('save'); break; } node.textContent = i18next.t('save');");
  const r = f.run();
  assert.equal(r.status, 'PASS');
  assert.equal(r.references, 3);
});
for (const statement of [
  'switch (kind) { case 1: var t = custom; break; }',
  'for (var t = custom; flag; ) {}',
  'for (var t of callbacks) {}',
  'for (var t in callbacks) {}',
  'for (var {t} of callbacks) {}',
  'for (var [t] of callbacks) {}',
  'if (flag) { var t = custom; }',
  'var t = custom;',
]) {
  for (const inFunction of [false, true]) {
    test('B02 var initialization invalidates translators: ' + statement + '/' + inFunction, t => {
      const f = fixture(t);
      const code = "var {t} = require('i18next'); " + statement + " node.textContent = t('save');";
      f.write('src/code.cjs', inFunction ? 'function render() {' + code + '}' : code);
      const r = f.run();
      assert.equal(r.status, 'UNVERIFIED');
      assert.ok(r.unknown.some(i => i.code === 'TRANSLATOR_REASSIGNED'));
    });
  }
}
test('B02 namespace initialization and destructured writes invalidate translators', t => {
  const f = fixture(t);
  for (const code of [
    "var i18next = require('i18next'); switch (kind) { case 1: var i18next = custom; } node.textContent = i18next.t('save');",
    "var {t} = require('i18next'); ({t} = custom); node.textContent = t('save');",
    "var {t} = require('i18next'); [t] = callbacks; node.textContent = t('save');",
    "var {t} = require('i18next'); t++; node.textContent = t('save');",
  ]) {
    f.write('src/code.cjs', code);
    const r = f.run();
    assert.equal(r.status, 'UNVERIFIED', code);
    assert.ok(r.unknown.some(i => i.code === 'TRANSLATOR_REASSIGNED'), code);
  }
});
for (const statement of [
  '[i.t] = [custom];',
  '({translate: i.t} = custom);',
  '[i.t = custom] = callbacks;',
  '[...i.t] = callbacks;',
  'for ([i.t] of callbacks) {}',
]) {
  test('B02 destructured namespace members invalidate translators: ' + statement, t => {
    const f = fixture(t);
    f.write('src/code.js', "import i from 'i18next'; " + statement + " node.textContent = i.t('save');");
    const result = f.run();
    assert.equal(result.status, 'UNVERIFIED');
    assert.ok(result.unknown.some(item => item.code === 'TRANSLATOR_REASSIGNED'));
  });
}
test('B02 destructuring reads and unrelated member writes retain translators', t => {
  const f = fixture(t);
  for (const statement of ["({[i.t('save')]: value} = custom);", '[other.t] = callbacks;']) {
    f.write('src/code.js', "import i from 'i18next'; " + statement + " node.textContent = i.t('save');");
    assert.equal(f.run().status, 'PASS', statement);
  }
});
test('B02 ordinary initialization, empty var redeclarations and local functions remain valid', t => {
  const f = fixture(t);
  for (const code of [
    "var {t} = require('i18next'); var t; node.textContent = t('save');",
    "var {t} = require('i18next'); for (var t; flag; ) { node.textContent = t('save'); }",
    "function render() { var {t} = require('i18next'); node.textContent = t('save'); }",
    "var {t} = require('i18next'); function other() { var t = custom; } node.textContent = t('save');",
    "var {t} = require('i18next'); { let t = custom; t = another; } node.textContent = t('save');",
  ]) {
    f.write('src/code.cjs', code);
    const r = f.run();
    assert.equal(r.status, 'PASS', code);
    assert.equal(r.references, 2, code);
  }
});
for (const declaration of ['var', 'let', 'const']) {
  test('namespace writes through block imports are unverified: ' + declaration, t => {
    const f = fixture(t);
    f.write('src/code.cjs', "var i = require('i18next'); { " + declaration + " same = require('i18next'); same.t = custom; } node.textContent = i.t('save');");
    const r = f.run();
    assert.equal(r.status, 'UNVERIFIED');
    assert.ok(r.unknown.some(i => i.code === 'TRANSLATOR_REASSIGNED'));
  });
}
for (const setup of [
  'const alias = i;',
  'let alias; alias = i;',
  'const middle = i; const alias = middle;',
  "const alias = require('i18next');",
]) {
  test('namespace aliases propagate member writes: ' + setup, t => {
    const f = fixture(t);
    f.write('src/code.cjs', "const i = require('i18next'); " + setup + " alias.t = custom; node.textContent = i.t('save');");
    const r = f.run();
    assert.equal(r.status, 'UNVERIFIED');
    assert.ok(r.unknown.some(i => i.code === 'TRANSLATOR_REASSIGNED'));
  });
}
for (const statement of ['[alias.t] = callbacks;', 'for ([alias.t] of callbacks) {}']) {
  test('destructured alias members invalidate the namespace: ' + statement, t => {
    const f = fixture(t);
    f.write('src/code.cjs', "const i = require('i18next'); const alias = i; " + statement + " node.textContent = i.t('save');");
    assert.equal(f.run().status, 'UNVERIFIED');
  });
}
for (const code of [
  "var {t} = require('i18next'); class C { static { var t = custom; } } node.textContent = t('save');",
  "var {t} = require('i18next'); class C { static { if (flag) { var t = custom; } } } node.textContent = t('save');",
  "var {t} = require('i18next'); const C = class { static { var t = custom; } }; node.textContent = t('save');",
]) {
  test('static block var scopes do not mutate outer translators: ' + code, t => {
    const f = fixture(t); f.write('src/code.cjs', code);
    const r = f.run();
    assert.equal(r.status, 'PASS');
    assert.equal(r.references, 2);
  });
}
test('static block hoisting shadows only its own translation calls', t => {
  const f = fixture(t);
  f.write('src/code.cjs', "var {t} = require('i18next'); class C { static { node.textContent = t('save'); var t = custom; } } node.title = t('save');");
  const r = f.run();
  assert.equal(r.status, 'UNVERIFIED');
  assert.equal(r.references, 2);
});
for (const expression of ["t = t('missing')", "t += t('missing')", "({t} = {t: t('missing')})"]) {
  test('assignment RHS translation keys are checked before writes: ' + expression, t => {
    const f = fixture(t);
    f.write('src/code.cjs', "var {t} = require('i18next'); " + expression + '; node.textContent = t;');
    const r = f.run();
    assert.equal(r.status, 'FAIL');
    assert.equal(r.issues.filter(i => i.code === 'TRANSLATION_MISSING').length, 2);
    assert.ok(r.unknown.some(i => i.code === 'TRANSLATOR_REASSIGNED'));
  });
}
test('declarator RHS translation keys are checked before redeclarations', t => {
  const f = fixture(t);
  f.write('src/code.cjs', "var {t} = require('i18next'); if (flag) { var t = t('missing'); } node.textContent = t;");
  assert.equal(f.run().status, 'FAIL');
});
for (const pattern of ["{t, [t('missing')]: value}", "{t: translate, [translate('missing')]: value}"]) {
  test('destructuring initializes earlier bindings before computed keys: ' + pattern, t => {
    const f = fixture(t);
    f.write('src/code.cjs', 'const ' + pattern + " = require('i18next');");
    const r = f.run();
    assert.equal(r.status, 'FAIL');
    assert.equal(r.issues.filter(i => i.code === 'TRANSLATION_MISSING').length, 2);
  });
}
test('destructuring computes target keys after RHS side effects', t => {
  const f = fixture(t);
  f.write('src/code.cjs', "const i = require('i18next'); ({[i.t('missing')]: value} = (i.t = custom, object)); node.textContent = i.t('save');");
  const r = f.run();
  assert.equal(r.status, 'UNVERIFIED');
  assert.ok(!r.issues.some(i => i.code === 'TRANSLATION_MISSING'));
});
test('namespace rebinds leave detached aliases intact', t => {
  const f = fixture(t);
  f.write('src/code.cjs', "let i = require('i18next'); const alias = i; i = custom; node.textContent = alias.t('missing');");
  const r = f.run();
  assert.equal(r.status, 'FAIL');
  assert.equal(r.issues.filter(i => i.code === 'TRANSLATION_MISSING').length, 2);
});
test('unrelated alias objects cannot invalidate translators', t => {
  const f = fixture(t);
  f.write('src/code.cjs', "const i = require('i18next'); { const alias = custom; alias.t = another; } node.textContent = i.t('save');");
  assert.equal(f.run().status, 'PASS');
});
for (const callable of [
  "function render() { t('missing'); }",
  "const render = () => t('missing');",
  "const render = function() { t('missing'); };",
]) {
  test('captured translators are checked after module initialization: ' + callable, t => {
    const f = fixture(t);
    f.write('src/code.cjs', callable + " var {t} = require('i18next'); render();");
    const r = f.run();
    assert.equal(r.status, 'FAIL');
    assert.equal(r.issues.filter(i => i.code === 'TRANSLATION_MISSING').length, 2);
  });
}
test('captured namespaces are checked when called before their declaration', t => {
  const f = fixture(t);
  f.write('src/code.cjs', "render(); function render() { i.t('save'); } var i = require('i18next');");
  assert.equal(f.run().status, 'UNVERIFIED');
});
test('repeated local calls do not duplicate static translation references', t => {
  const f = fixture(t);
  f.write('src/code.cjs', "function render() { t('save'); } var {t} = require('i18next'); render(); render();");
  const r = f.run();
  assert.equal(r.status, 'PASS');
  assert.equal(r.references, 2);
});
test('empty var redeclarations do not erase hoisted function calls', t => {
  const f = fixture(t);
  f.write('src/code.cjs', "function render() { t('missing'); } var {t} = require('i18next'); render(); t = custom; var render;");
  assert.equal(f.run().status, 'FAIL');
});
for (const callable of ["function render() { render(); t('save'); }", "const render = function self() { self(); t('save'); };"]) {
  test('recursive call scopes remain explicitly unverified: ' + callable, t => {
    const f = fixture(t);
    f.write('src/code.cjs', callable + " var {t} = require('i18next'); render();");
    const r = f.run();
    assert.equal(r.status, 'UNVERIFIED');
    assert.ok(r.unknown.some(i => i.code === 'RECURSIVE_CALL_SCOPE'));
  });
}
test('uncalled function sources still receive static translation coverage', t => {
  const f = fixture(t);
  f.write('src/code.cjs', "function render() { t('missing'); } var {t} = require('i18next');");
  assert.equal(f.run().status, 'FAIL');
});
test('repeated calls do not duplicate legacy visible-literal debt', t => {
  const f = fixture(t);
  f.write('src/code.cjs', "function render() { alert('Legacy'); } render();");
  f.input.baseline = { ...core.snapshot(f.root, ['src/page.html', 'src/code.cjs', 'locales/en.json', 'locales/zh.json']), sourceFiles: ['src/page.html', 'src/code.cjs'] };
  const authority = { baselineDigest: core.hash(f.input.baseline) };
  f.write('src/code.cjs', "function render() { alert('Legacy'); } render(); render();");
  const repeated = f.run(authority);
  assert.equal(repeated.status, 'PASS');
  assert.equal(repeated.existingIssues.length, 1);
  f.write('src/code.cjs', "function render() { alert('Legacy'); alert('Legacy'); } render();");
  const added = f.run(authority);
  assert.equal(added.status, 'FAIL');
  assert.equal(added.issues.length, 1);
});
test('member assignment retains the object evaluated before its RHS', t => {
  const f = fixture(t);
  f.write('src/code.cjs', "var i = require('i18next'), alias = i; i.t = (i = 0, custom); alias.t('missing');");
  const r = f.run();
  assert.equal(r.status, 'UNVERIFIED');
  assert.ok(!r.issues.some(i => i.code === 'TRANSLATION_MISSING'));
});
test('member assignments cannot invalidate a different object introduced by the RHS', t => {
  const f = fixture(t);
  f.write('src/code.cjs', "let i = custom; i.t = (i = require('i18next'), another); i.t('missing');");
  assert.equal(f.run().status, 'FAIL');
});
test('a shadowed require is not the real i18next import', t => {
  const f = fixture(t); f.write('src/code.cjs', "function render(require) { const {t} = require('i18next'); node.textContent = t('save'); }\n");
  assert.equal(f.run().status, 'UNVERIFIED');
});
test('hoisted var and reassigned namespace methods do not masquerade as translators', t => {
  const f = fixture(t); f.write('src/code.js', "import {t} from 'i18next';\nfunction render() { node.textContent = t('save'); if (flag) { var t = custom; } }\n");
  assert.equal(f.run().status, 'UNVERIFIED');
  f.write('src/code.js', "import i18next from 'i18next'; i18next.t = custom; node.textContent = i18next.t('save');");
  assert.equal(f.run().status, 'UNVERIFIED');
});
test('dynamic UI and dynamic keys are explicitly unverified', t => {
  const f = fixture(t); f.write('src/code.js', "import {t} from 'i18next'; node.textContent = t(prefix + key);\n");
  assert.equal(f.run().status, 'UNVERIFIED');
  f.write('src/code.js', 'node.textContent = `${dynamic}`;'); assert.equal(f.run().status, 'UNVERIFIED');
});
test('source literals assigned indirectly to UI are detected', t => {
  const f = fixture(t); f.write('src/code.js', "const label = 'Save'; node.textContent = label;");
  assert.equal(f.run().status, 'FAIL');
});
test('mutated labels and bracket-access UI properties cannot create false PASS', t => {
  const f = fixture(t); f.write('src/code.js', "let s='';s='X';node.textContent=s;");
  assert.notEqual(f.run().status, 'PASS');
  f.write('src/code.js', "node['textContent']='X';");
  assert.equal(f.run().status, 'FAIL');
  f.write('src/code.js', "node['setAttribute']('aria-label','X');");
  assert.equal(f.run().status, 'FAIL');
});
test('HTML injection and unknown dynamic member sinks stay unverified', t => {
  const f = fixture(t); f.write('src/code.js', "node.innerHTML = '<p>Hardcoded</p>';");
  assert.equal(f.run().status, 'UNVERIFIED');
  f.write('src/code.js', "node[property] = 'X';");
  assert.equal(f.run().status, 'UNVERIFIED');
});
test('missing key, missing locale package and empty translation cannot pass via fallback', t => {
  const f = fixture(t); f.write('locales/zh.json', { save: '' });
  assert.equal(f.run().status, 'FAIL');
  fs.unlinkSync(path.join(f.root, 'locales/zh.json')); assert.equal(f.run().status, 'UNVERIFIED');
});
test('parameter contracts are checked for every mandatory locale', t => {
  const f = fixture(t); f.write('src/code.js', "import {t} from 'i18next'; node.textContent = t('welcome');");
  assert.equal(f.run().issues.filter(i => i.code === 'PARAMETER_MISSING').length, 2);
  f.write('src/code.js', "import {t} from 'i18next'; node.textContent = t('welcome', {name: 'User'});");
  assert.equal(f.run().status, 'PASS');
});
test('plural forms follow each locale rather than forcing identical branches', t => {
  const f = fixture(t); f.write('src/code.js', "import {t} from 'i18next'; node.textContent = t('items', {count: 2});");
  f.write('locales/en.json', { save: 'Save', items_one: '{{count}} item', items_other: '{{count}} items' });
  f.write('locales/zh.json', { save: '保存', items_other: '{{count}}项' });
  assert.equal(f.run().status, 'PASS');
  f.write('locales/en.json', { save: 'Save', items_other: '{{count}} items' }); assert.equal(f.run().status, 'FAIL');
});
test('duplicate, executable and malformed message resources remain unverified', t => {
  const f = fixture(t); f.write('locales/en.json', '{"save":"one","save":"two"}'); assert.equal(f.run().status, 'UNVERIFIED');
  f.write('locales/en.json', "require('fs').writeFileSync('sentinel','bad')"); assert.equal(f.run().status, 'UNVERIFIED');
  assert.equal(fs.existsSync(path.join(f.root, 'sentinel')), false);
  f.write('locales/en.json', { save: 'Save {{broken' }); assert.equal(f.run().status, 'UNVERIFIED');
});
test('unknown frameworks and zero parsed files are not silently accepted', t => {
  const f = fixture(t); f.write('src/page.vue', '<template>{{ t("save") }}</template>'); assert.equal(f.run().status, 'UNVERIFIED');
  f.input.sourceRoots = ['absent']; assert.equal(f.run().status, 'UNVERIFIED');
});
test('resource deletion checks unchanged callers through source-root enumeration', t => {
  const f = fixture(t); f.write('src/unchanged.js', "import {t} from 'i18next'; node.textContent = t('welcome',{name:'X'});");
  assert.equal(f.run().status, 'PASS');
  f.write('locales/zh.json', { save: '保存' });
  const r = f.run(); assert.equal(r.status, 'FAIL'); assert.ok(r.issues.some(i => i.file === 'src/unchanged.js'));
});
test('staged i18n checks never read untracked or unstaged edits', t => {
  const f = fixture(t);
  const git = args => { const r = spawnSync('git', ['-C', f.root, ...args], { encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
  git(['init', '--quiet']); git(['add', '--', 'src', 'locales']);
  f.input.snapshotMode = 'staged'; assert.equal(f.run().status, 'PASS');
  f.write('src/page.html', '<button>Hardcoded</button>'); f.write('locales/zh.json', {}); f.write('src/untracked.html', '<h1>New</h1>');
  assert.equal(f.run().status, 'PASS');
  f.input.snapshotMode = 'working-tree'; assert.equal(f.run().status, 'FAIL');
});
test('independent baseline separates moved old debt from newly introduced duplicates', t => {
  const f = fixture(t); f.write('src/page.html', '<button>Legacy</button>');
  const names = ['src/page.html', 'locales/en.json', 'locales/zh.json'];
  f.input.baseline = { ...core.snapshot(f.root, names), sourceFiles: ['src/page.html'] };
  const authority = { baselineDigest: core.hash(f.input.baseline) };
  assert.throws(() => f.run(), { code: 'BASELINE_UNTRUSTED' });
  f.write('src/page.html', '\n\n<button>Legacy</button>');
  assert.equal(f.run(authority).status, 'PASS'); assert.equal(f.run(authority).existingIssues.length, 1);
  f.write('src/page.html', '<button>Legacy</button><button>Legacy</button>');
  assert.equal(f.run(authority).issues.length, 1);
});
test('confirmed renames preserve old debt while copies cannot borrow its provenance', t => {
  const f = fixture(t); f.write('src/page.html', '<h1>Legacy</h1>');
  f.input.baseline = { ...core.snapshot(f.root, ['src/page.html', 'locales/en.json', 'locales/zh.json']), sourceFiles: ['src/page.html'] };
  f.input.renames = [{ from: 'src/page.html', to: 'src/renamed.html' }];
  const authority = { baselineDigest: core.hash(f.input.baseline), renameDigest: core.hash(f.input.renames) };
  fs.renameSync(path.join(f.root, 'src/page.html'), path.join(f.root, 'src/renamed.html'));
  assert.equal(f.run(authority).status, 'PASS'); assert.equal(f.run(authority).existingIssues.length, 1);
  assert.throws(() => f.run({ baselineDigest: authority.baselineDigest }), { code: 'RENAME_UNTRUSTED' });
  f.write('src/page.html', '<h1>Legacy</h1>');
  assert.throws(() => f.run(authority), { code: 'RENAME_UNTRUSTED' });
});
test('exceptions need exact scope, evidence and unexpired host approval', t => {
  const f = fixture(t); f.write('src/page.html', '<button>Brand</button>'); const issue = f.run().issues[0];
  f.write('exception.json', { reason: 'proper brand name' });
  const exception = { issueDigest: core.hash(issue), file: issue.file, taskId: 't', reason: 'proper brand name', approvalRef: 'user-source', expiresAt: new Date(Date.now() + 60000).toISOString(), source: { path: 'exception.json', sha256: core.hash(fs.readFileSync(path.join(f.root, 'exception.json'))) } };
  f.input.exceptions = [exception]; assert.equal(f.run().status, 'FAIL');
  assert.equal(f.run({ exceptionDigests: [core.hash(exception)] }).status, 'PASS');
  exception.expiresAt = '2000-01-01T00:00:00Z'; assert.equal(f.run({ exceptionDigests: [core.hash(exception)] }).status, 'FAIL');
});
