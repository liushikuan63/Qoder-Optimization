#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const core = require('./convention-core.cjs');

const SOURCE_EXTENSIONS = /\.(?:html?|cjs|mjs|js|jsx|tsx?|vue|svelte|hbs)$/i;
const VISIBLE_ATTRIBUTES = new Set(['title', 'placeholder', 'alt', 'aria-label', 'label']);
function sourceFiles(root, roots, mode) {
  if (!Array.isArray(roots) || !roots.length) core.fail('SCOPE_MISSING', 'explicit source roots are required');
  const found = new Set();
  for (const scope of roots) {
    core.relativeName(scope, true);
    if (mode === 'staged') {
      for (const file of core.git(root, ['ls-files', '--cached', '-z', '--', scope]).split('\0').filter(Boolean)) if (SOURCE_EXTENSIONS.test(file)) found.add(file);
      continue;
    }
    function visit(relative, depth) {
      if (depth > 20 || found.size > 180) core.fail('SCOPE_LIMIT', 'source scan exceeds supported bounds');
      const absolute = relative === '.' ? root : core.projectFile(root, relative);
      if (!fs.existsSync(absolute)) return;
      if (fs.lstatSync(absolute).isSymbolicLink()) core.fail('PATH_SCOPE', 'source root contains a redirected entry');
      if (fs.statSync(absolute).isFile()) { if (SOURCE_EXTENSIONS.test(relative)) found.add(relative); return; }
      for (const item of fs.readdirSync(absolute, { withFileTypes: true })) {
        if (['node_modules', '.git'].includes(item.name)) continue;
        visit(relative === '.' ? item.name : relative + '/' + item.name, depth + 1);
      }
    }
    visit(scope, 0);
  }
  return [...found].sort();
}
function parseJavaScript(file, refs, issues, unknown) {
  let ast;
  const isScript = file.path.endsWith('.cjs');
  try { ast = core.dependencies().acorn.parse(file.content, { ecmaVersion: 'latest', sourceType: isScript ? 'script' : 'module', locations: true }); }
  catch { unknown.push({ code: 'UNSUPPORTED_SYNTAX', file: file.path }); return false; }
  const loc = node => ({ file: file.path, line: node.loc.start.line });
  const children = node => Object.values(node).flatMap(value => Array.isArray(value) ? value.filter(v => v?.type) : value?.type ? [value] : []);
  const namespace = { valid: true };
  const functions = new Map(), activeFunctions = new Set(), visitedFunctions = new Set(), referenceNodes = new Set(), issueNodes = new Set();
  const isFunction = node => /Function(?:Declaration|Expression)$/.test(node.type) || node.type === 'ArrowFunctionExpression';
  const scopeFor = (nodes, initial = [], hoist = false) => {
    const scope = new Map();
    function bind(pattern, value = { kind: null, init: null }) {
      if (!pattern) return;
      if (pattern.type === 'Identifier') scope.set(pattern.name, { ...value });
      else if (pattern.type === 'ObjectPattern') pattern.properties.forEach(p => bind(p.value || p.argument));
      else if (pattern.type === 'ArrayPattern') pattern.elements.forEach(p => bind(p));
      else if (pattern.type === 'AssignmentPattern') bind(pattern.left);
      else if (pattern.type === 'RestElement') bind(pattern.argument);
    }
    function declare(declaration) {
      const init = declaration.init;
      const pendingTranslation = (init?.type === 'CallExpression' && init.callee.name === 'require' && init.arguments[0]?.value === 'i18next')
        || (init?.type === 'MemberExpression' && (init.property.name || init.property.value) === 't');
      bind(declaration.id, { kind: null, init: null, pendingTranslation: pendingTranslation || scope.get(declaration.id.name)?.pendingTranslation || false });
    }
    initial.forEach(pattern => bind(pattern));
    if (hoist) {
      const collect = node => {
        if (isFunction(node) || ['ClassDeclaration', 'ClassExpression', 'StaticBlock'].includes(node.type)) return;
        if (node.type === 'VariableDeclaration' && node.kind === 'var') node.declarations.forEach(declare);
        children(node).forEach(collect);
      };
      nodes.forEach(collect);
    }
    for (const node of nodes) {
      if (node.type === 'ImportDeclaration') for (const s of node.specifiers) {
        let kind = null;
        if (node.source.value === 'i18next') kind = s.type === 'ImportSpecifier' && s.imported.name === 't' ? 'translate' : ['ImportDefaultSpecifier', 'ImportNamespaceSpecifier'].includes(s.type) ? 'namespace' : null;
        bind(s['local'], { kind, namespace: kind === 'namespace' ? namespace : null, initialized: true });
      }
      if (node.type === 'VariableDeclaration' && node.kind !== 'var') node.declarations.forEach(declare);
      if (node.type === 'FunctionDeclaration') bind(node.id, { kind: null, callable: node, initialized: true });
      if (node.type === 'ClassDeclaration') bind(node.id);
    }
    return { scope, bind };
  };
  const resolve = (name, scopes) => { for (const scope of [...scopes].reverse()) if (scope.has(name)) return scope.get(name); return undefined; };
  const memberName = node => node.computed ? node.property.type === 'Literal' && typeof node.property.value === 'string' ? node.property.value : null : node.property.name;
  const namespaceBinding = (node, scopes) => node?.type === 'Identifier' && resolve(node.name, scopes)?.kind === 'namespace' ? resolve(node.name, scopes) : null;
  const captureMember = (node, scopes) => { const binding = namespaceBinding(node.object, scopes); return binding ? { namespace: binding.namespace } : null; };
  const translated = (node, scopes) => node?.type === 'CallExpression' && ((node.callee.type === 'Identifier' && resolve(node.callee.name, scopes)?.kind === 'translate')
    || (node.callee.type === 'MemberExpression' && memberName(node.callee) === 't' && namespaceBinding(node.callee.object, scopes)?.namespace.valid));
  function bindingValue(node, scopes) {
    if (node?.type === 'Identifier') return resolve(node.name, scopes);
    if (node?.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'require' && resolve('require', scopes) === undefined
        && node.arguments.length === 1 && node.arguments[0].value === 'i18next') return { kind: 'namespace', namespace };
    if (node?.type === 'MemberExpression' && memberName(node) === 't' && namespaceBinding(node.object, scopes)?.namespace.valid) return { kind: 'translate' };
    return null;
  }
  function options(node) {
    if (!node) return { keys: [], namespace: null, plural: false };
    if (node.type !== 'ObjectExpression' || node.properties.some(p => p.type !== 'Property' || p.computed || p.method)) return null;
    const keys = node.properties.map(p => p.key.name || p.key.value);
    const ns = node.properties.find(p => (p.key.name || p.key.value) === 'ns');
    if (ns && (ns.value.type !== 'Literal' || typeof ns.value.value !== 'string')) return null;
    return { keys, namespace: ns?.value.value || null, plural: keys.includes('count') };
  }
  const literalText = (node, scopes, depth = 0) => {
    if (!node || depth > 8) return null;
    if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
    if (node.type === 'TemplateLiteral') { const literal = node.quasis.map(q => q.value.cooked).join(''); return node.expressions.length && !literal.trim() ? null : literal; }
    if (node.type === 'Identifier') { const binding = resolve(node.name, scopes); return binding?.mutated ? null : literalText(binding?.init, scopes, depth + 1); }
    if (node.type === 'BinaryExpression' && node.operator === '+') {
      const left = literalText(node.left, scopes, depth + 1), right = literalText(node.right, scopes, depth + 1);
      return left === null && right === null ? null : (left || '') + (right || '');
    }
    return null;
  };
  function checkVisible(value, node, scopes) {
    if (translated(value, scopes)) return;
    const literal = literalText(value, scopes);
    if (literal?.trim()) {
      if (!issueNodes.has(node)) { issues.push({ code: 'VISIBLE_LITERAL', ...loc(node), value: literal }); issueNodes.add(node); }
    } else if (literal === null) unknown.push({ code: 'DYNAMIC_VISIBLE_TEXT', ...loc(node) });
  }
  function markWrite(pattern, node, scopes, initializer, capturedMember) {
    function collect(target, value = null, evaluate = false) {
      if (!target) return;
      if (target.type === 'Identifier') {
        const binding = resolve(target.name, scopes);
        if (!binding) return;
        const first = node.type === 'VariableDeclarator' && !binding.initialized;
        if (!first && binding.kind) unknown.push({ code: 'TRANSLATOR_REASSIGNED', ...loc(node) });
        binding.kind = value?.kind || null;
        binding.namespace = value?.namespace || null;
        binding.callable = target === pattern && initializer && isFunction(initializer) ? initializer : value?.callable || null;
        binding.init = first ? initializer : null;
        binding.mutated = !first;
        binding.initialized = true;
      } else if (target.type === 'MemberExpression') {
        const binding = !evaluate && capturedMember !== undefined ? capturedMember : captureMember(target, scopes);
        if (evaluate) walk(target, scopes);
        if (binding && ['t', null].includes(memberName(target))) {
          unknown.push({ code: 'TRANSLATOR_REASSIGNED', ...loc(node) });
          binding.namespace.valid = false;
        }
      } else if (target.type === 'RestElement') collect(target.argument, null, true);
      else if (target.type === 'AssignmentPattern') {
        walk(target.right, scopes);
        collect(target.left, value, true);
      } else if (target.type === 'ArrayPattern') target.elements.forEach(element => collect(element, null, true));
      else if (target.type === 'ObjectPattern') target.properties.forEach(property => {
        if (property.computed) walk(property.key, scopes);
        const translation = value?.kind === 'namespace' && value.namespace.valid && !property.computed && (property.key?.name || property.key?.value) === 't';
        collect(property.type === 'RestElement' ? property.argument : property.value, translation ? { kind: 'translate' } : null, true);
      });
    }
    collect(pattern, initializer ? bindingValue(initializer, scopes) : null);
  }
  function analyzeFunction(node, scopes) {
    if (activeFunctions.has(node)) { unknown.push({ code: 'RECURSIVE_CALL_SCOPE', ...loc(node) }); return; }
    functions.set(node, scopes);
    activeFunctions.add(node);
    visitedFunctions.add(node);
    const named = node.type === 'FunctionExpression' && node.id ? new Map([[node.id.name, { kind: null, callable: node, initialized: true }]]) : null;
    const local = scopeFor(node.body.body || [], node.params, true);
    const inner = [...scopes, ...(named ? [named] : []), local.scope];
    node.params.forEach(parameter => walk(parameter, inner));
    walk(node.body, inner);
    activeFunctions.delete(node);
  }
  function walk(node, scopes) {
    if (isFunction(node)) { functions.set(node, scopes); return; }
    if (['Program', 'BlockStatement', 'StaticBlock'].includes(node.type)) {
      const local = scopeFor(node.body, [], node.type !== 'BlockStatement'); scopes = [...scopes, local.scope];
    } else if (node.type === 'CatchClause') { const local = scopeFor([], [node.param]); scopes = [...scopes, local.scope]; }
    else if (['ForStatement', 'ForOfStatement', 'ForInStatement'].includes(node.type)) {
      const declaration = node.type === 'ForStatement' ? node.init : node.left;
      if (declaration?.type === 'VariableDeclaration' && declaration.kind !== 'var') scopes = [...scopes, scopeFor([declaration]).scope];
      if (node.type !== 'ForStatement') {
        walk(node.right, scopes);
        const target = declaration.type === 'VariableDeclaration' ? declaration.declarations[0].id : declaration;
        const captured = target.type === 'MemberExpression' ? captureMember(target, scopes) : undefined;
        if (target.type === 'MemberExpression') walk(target, scopes);
        markWrite(target, node, scopes, null, captured);
        walk(node.body, scopes);
        return;
      }
    } else if (node.type === 'SwitchStatement') {
      walk(node.discriminant, scopes);
      const local = scopeFor(node.cases.flatMap(branch => branch.consequent));
      for (const branch of node.cases) walk(branch, [...scopes, local.scope]);
      return;
    }
    if (node.type === 'AssignmentExpression') {
      const destructured = ['ArrayPattern', 'ObjectPattern'].includes(node.left.type);
      const captured = node.left.type === 'MemberExpression' ? captureMember(node.left, scopes) : undefined;
      if (!destructured) walk(node.left, scopes);
      walk(node.right, scopes);
      if (node.left.type === 'MemberExpression') {
        const property = memberName(node.left);
        if (['textContent', 'innerText', 'title', 'placeholder', 'ariaLabel'].includes(property)) checkVisible(node.right, node, scopes);
        else if (property === 'innerHTML' || property === 'outerHTML' || property === null) unknown.push({ code: 'UNSUPPORTED_VISIBLE_SINK', ...loc(node) });
      }
      markWrite(node.left, node, scopes, node.operator === '=' ? node.right : null, captured);
      return;
    }
    if (node.type === 'VariableDeclarator' && node.init) {
      walk(node.init, scopes);
      markWrite(node.id, node, scopes, node.init);
      return;
    }
    if (node.type === 'UpdateExpression') {
      const captured = node.argument.type === 'MemberExpression' ? captureMember(node.argument, scopes) : undefined;
      walk(node.argument, scopes);
      markWrite(node.argument, node, scopes, null, captured);
      return;
    }
    let callable = null, closure = scopes;
    if (node.type === 'CallExpression') {
      const target = node.callee.type === 'Identifier' ? node.callee : node.callee.type === 'MemberExpression' ? node.callee.object : null;
      const binding = target?.type === 'Identifier' ? resolve(target.name, scopes) : null;
      if (binding?.pendingTranslation && !binding.initialized) unknown.push({ code: 'TRANSLATOR_NOT_INITIALIZED', ...loc(node) });
      callable = isFunction(node.callee) ? node.callee : node.callee.type === 'Identifier' ? binding?.callable : null;
      if (callable) {
        const owner = [...scopes].reverse().find(scope => scope.get(target?.name) === binding);
        closure = functions.get(callable) || (owner ? scopes.slice(0, scopes.indexOf(owner) + 1) : scopes);
      }
    }
    if (translated(node, scopes)) {
      const key = node.arguments[0], params = options(node.arguments[1]);
      if (key?.type !== 'Literal' || typeof key.value !== 'string' || !params || node.arguments.length > 2) unknown.push({ code: 'DYNAMIC_TRANSLATION', ...loc(node) });
      else if (!referenceNodes.has(node)) { refs.push({ key: key.value, ...params, ...loc(node) }); referenceNodes.add(node); }
    }
    if (node.type === 'CallExpression') {
      if (node.callee.type === 'Identifier' && ['alert', 'confirm', 'prompt'].includes(node.callee.name) && resolve(node.callee.name, scopes) === undefined) checkVisible(node.arguments[0], node, scopes);
      if (node.callee.type === 'MemberExpression' && memberName(node.callee) === 'setAttribute' && VISIBLE_ATTRIBUTES.has(node.arguments[0]?.value)) checkVisible(node.arguments[1], node, scopes);
    }
    for (const child of children(node)) walk(child, scopes);
    if (callable) analyzeFunction(callable, closure);
  }
  walk(ast, []);
  for (const [node, scopes] of functions) if (!visitedFunctions.has(node)) analyzeFunction(node, scopes);
  return true;
}
function parseHtml(file, refs, issues, unknown) {
  const html = core.dependencies().parse5.parseFragment(file.content, { sourceCodeLocationInfo: true });
  function visit(node, translatedParent = false) {
    if (['script', 'style'].includes(node.tagName)) {
      if (node.tagName === 'script' && !node.attrs.some(a => a.name === 'src') && node.childNodes.some(n => n.value?.trim())) unknown.push({ code: 'INLINE_SCRIPT', file: file.path, line: node.sourceCodeLocation?.startLine || 1 });
      return;
    }
    const attrs = Object.fromEntries((node.attrs || []).map(a => [a.name, a.value]));
    const line = node.sourceCodeLocation?.startLine || 1;
    const covered = new Set();
    if (attrs['data-i18n']) {
      let params = {};
      try { if (attrs['data-i18n-options']) params = core.parseJson(attrs['data-i18n-options']); }
      catch { unknown.push({ code: 'INVALID_TRANSLATION_OPTIONS', file: file.path, line }); }
      if (!params || Array.isArray(params) || typeof params !== 'object') { unknown.push({ code: 'INVALID_TRANSLATION_OPTIONS', file: file.path, line }); params = {}; }
      for (const instruction of attrs['data-i18n'].split(';')) {
        const match = instruction.match(/^(?:\[([a-z-]+)\])?([A-Za-z0-9_.:-]+)$/);
        if (!match || (match[1] && !VISIBLE_ATTRIBUTES.has(match[1]) && match[1] !== 'value')) { unknown.push({ code: 'UNSUPPORTED_TRANSLATION_ATTRIBUTE', file: file.path, line }); continue; }
        covered.add(match[1] || 'text');
        refs.push({ key: match[2], keys: Object.keys(params), namespace: typeof params.ns === 'string' ? params.ns : null, plural: Object.hasOwn(params, 'count'), file: file.path, line });
      }
    }
    for (const [name, value] of Object.entries(attrs)) {
      if ((VISIBLE_ATTRIBUTES.has(name) || (name === 'value' && node.tagName === 'input' && ['button', 'submit', 'reset'].includes(attrs.type))) && value.trim() && !covered.has(name)) issues.push({ code: 'VISIBLE_ATTRIBUTE', file: file.path, line, attribute: name, value });
    }
    if (node.nodeName === '#text' && node.value.trim() && !translatedParent) issues.push({ code: 'VISIBLE_LITERAL', file: file.path, line, value: node.value.trim() });
    for (const child of node.childNodes || []) visit(child, covered.has('text'));
    if (node.content) visit(node.content);
  }
  visit(html);
  return true;
}
function flatten(value, prefix = '', output = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) core.fail('UNSUPPORTED_RESOURCE', 'catalog roots must be objects');
  for (const [key, item] of Object.entries(value)) {
    const name = prefix ? prefix + '.' + key : key;
    if (item && typeof item === 'object' && !Array.isArray(item)) flatten(item, name, output);
    else if (typeof item === 'string') {
      if (Object.hasOwn(output, name)) core.fail('DUPLICATE_KEY', 'duplicate flattened translation key');
      Object.defineProperty(output, name, { value: item, enumerable: true, configurable: true });
    } else core.fail('UNSUPPORTED_RESOURCE', 'catalog values must be nested string messages');
  }
  return output;
}
function analyze(current, config, sources) {
  const issues = [], unknown = [], refs = [];
  let parsed = 0;
  const files = new Map(current.files.map(f => [f.path, f]));
  if (!Array.isArray(config?.requiredLocales) || !config.requiredLocales.length || !config.requiredLocales.includes(config.defaultLocale) || !config.namespaces || !core.text(config.defaultNamespace)) core.fail('INVALID_CATALOG', 'explicit locales and namespaces are required');
  for (const name of sources) {
    const file = files.get(name);
    if (!file?.exists) { unknown.push({ code: 'SOURCE_MISSING', file: name }); continue; }
    if (/\.html?$/.test(name)) parsed += Number(parseHtml(file, refs, issues, unknown));
    else if (/\.(?:cjs|mjs|js)$/.test(name)) parsed += Number(parseJavaScript(file, refs, issues, unknown));
    else unknown.push({ code: 'UNSUPPORTED_SYNTAX', file: name });
  }
  const catalogs = new Map();
  for (const [namespace, locales] of Object.entries(config.namespaces)) for (const locale of config.requiredLocales) {
    const name = locales[locale], entry = name && files.get(name);
    if (!entry?.exists) { unknown.push({ code: 'CATALOG_MISSING', namespace, locale }); continue; }
    try { catalogs.set(namespace + '/' + locale, flatten(core.parseJson(entry.content))); }
    catch (error) { unknown.push({ code: error.code || 'INVALID_CATALOG', file: name }); }
  }
  for (const ref of refs) {
    const separator = ref.key.indexOf(':');
    const namespace = separator < 0 ? ref.namespace || config.defaultNamespace : ref.key.slice(0, separator);
    const key = separator < 0 ? ref.key : ref.key.slice(separator + 1);
    for (const locale of config.requiredLocales) {
      const catalog = catalogs.get(namespace + '/' + locale);
      if (!catalog) { unknown.push({ code: 'NAMESPACE_MISSING', file: ref.file, namespace, locale }); continue; }
      let keys;
      try { keys = ref.plural ? new Intl.PluralRules(locale).resolvedOptions().pluralCategories.map(c => key + '_' + c) : [key]; }
      catch { unknown.push({ code: 'LOCALE_UNSUPPORTED', locale }); continue; }
      for (const lookup of keys) {
        const value = Object.hasOwn(catalog, lookup) ? catalog[lookup] : null;
        if (typeof value !== 'string' || !value.trim()) { issues.push({ code: 'TRANSLATION_MISSING', file: ref.file, key: lookup, namespace, locale }); continue; }
        if (/\{[^{}]+,\s*(?:plural|select|selectordinal)\b/.test(value)) { unknown.push({ code: 'ICU_UNSUPPORTED', key: lookup, locale }); continue; }
        const paramPattern = /\{\{\s*-?\s*([A-Za-z_][A-Za-z0-9_.]*)\s*\}\}/g;
        const params = [...value.matchAll(paramPattern)].map(m => m[1].split('.')[0]);
        if (/\{\{|\}\}/.test(value.replace(paramPattern, ''))) unknown.push({ code: 'MESSAGE_FORMAT_UNSUPPORTED', key: lookup, locale });
        for (const param of params) if (!ref.keys.includes(param)) issues.push({ code: 'PARAMETER_MISSING', file: ref.file, key: lookup, locale, parameter: param });
      }
    }
  }
  if (!parsed) unknown.push({ code: 'ZERO_PARSED' });
  return { issues, unknown, refs, parsed };
}
function check(input, authority = {}) {
  if (!input || input.schema !== 1) core.fail('INVALID_INPUT', 'schema=1 is required');
  const root = core.projectRoot(input.projectRoot), mode = input.snapshotMode || 'working-tree';
  const sources = sourceFiles(root, input.sourceRoots, mode);
  const catalogFiles = Object.values(input.catalog?.namespaces || {}).flatMap(locales => Object.values(locales));
  const names = [...new Set([...sources, ...catalogFiles])];
  if (!names.length) return { ...core.aggregate([]), id: 'i18n.catalog' };
  const current = core.snapshot(root, names, mode), evaluated = analyze(current, input.catalog, sources);
  let introduced = evaluated.issues, existingIssues = [];
  if (input.baseline) {
    if (authority.baselineDigest !== core.hash(input.baseline) || input.baseline.worktreeId !== current.worktreeId || input.baseline.mode !== current.mode) core.fail('BASELINE_UNTRUSTED', 'baseline must be independently frozen for this worktree and mode');
    const before = analyze(input.baseline, input.catalog, input.baseline.sourceFiles || sources);
    const renames = input.renames || [];
    if (!Array.isArray(renames) || (renames.length && authority.renameDigest !== core.hash(renames))) core.fail('RENAME_UNTRUSTED', 'rename attribution requires independent host confirmation');
    if (new Set(renames.map(r => r.from)).size !== renames.length || new Set(renames.map(r => r.to)).size !== renames.length) core.fail('RENAME_UNTRUSTED', 'rename attribution must be one-to-one');
    for (const rename of renames) {
      core.relativeName(rename.from); core.relativeName(rename.to);
      if (!input.baseline.files.some(f => f.path === rename.from && f.exists) || current.files.some(f => f.path === rename.from && f.exists)
          || !current.files.some(f => f.path === rename.to && f.exists)) core.fail('RENAME_UNTRUSTED', 'rename does not match the before and current file sets');
    }
    const key = (issue, renamed = false) => {
      const normalized = { ...issue };
      if (renamed) normalized.file = renames.find(r => r.to === issue.file)?.from || issue.file;
      return core.hash(Object.fromEntries(Object.entries(normalized).filter(([k]) => k !== 'line')));
    };
    const counts = new Map();
    before.issues.forEach(i => counts.set(key(i), (counts.get(key(i)) || 0) + 1));
    introduced = [];
    for (const issue of evaluated.issues) {
      const id = key(issue, true), count = counts.get(id) || 0;
      if (count) { existingIssues.push(issue); counts.set(id, count - 1); } else introduced.push(issue);
    }
  }
  const exceptions = [];
  const active = introduced.filter(issue => {
    const exception = (input.exceptions || []).find(e => e.issueDigest === core.hash(issue));
    if (!exception || !authority.exceptionDigests?.includes(core.hash(exception)) || !core.text(exception.reason) || !core.text(exception.approvalRef) || exception.taskId !== input.taskId || exception.file !== issue.file || !Number.isFinite(Date.parse(exception.expiresAt)) || Date.parse(exception.expiresAt) <= Date.now()) return true;
    core.verifySource(root, exception.source); exceptions.push(exception); return false;
  });
  const status = active.length ? 'FAIL' : evaluated.unknown.length ? 'UNVERIFIED' : 'PASS';
  return { schema: 1, version: core.VERSION, id: 'i18n.catalog', status, exitCode: status === 'FAIL' ? 1 : status === 'UNVERIFIED' ? 2 : 0, snapshotDigest: current.digest, worktreeId: current.worktreeId, files: current.files.map(({ content, ...f }) => f), issues: active, existingIssues, unknown: evaluated.unknown, exceptions, parsed: evaluated.parsed, references: evaluated.refs.length, level: 'static', limits: 'HTML data-i18n and JavaScript i18next bindings with JSON catalogs only. Runtime language loading, translations and visual layout are not verified.' };
}
module.exports = { sourceFiles, parseJavaScript, parseHtml, flatten, analyze, check };
if (require.main === module) core.cli(args => {
  if (args[0] !== 'check' || ![2, 4].includes(args.length) || (args.length === 4 && args[2] !== '--authority')) core.fail('USAGE', 'node convention-i18n.cjs check <request.json> [--authority <host-approval.json>]');
  return check(core.readJson(args[1]), args[3] ? core.readJson(args[3]) : {});
});
