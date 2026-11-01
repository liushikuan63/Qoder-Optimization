#!/usr/bin/env node
// asar-peek.cjs -- read-only forensics on a packed Electron app.asar (or any
// minified / near-binary bundle): locate a literal with a printable-filtered
// context window, brace-match a whole function out of the archive, then EXECUTE
// that shipped code against candidate inputs.
//
//   find <file> <literal> [--ctx N] [--max M] [--out FILE]
//   fn   <file> --name IDENT [--hint N] [--out FILE]   |   fn <file> --offset N
//   exec <file> --offset N --as NAME [--deps-file F] [--call EXPR]
//        [--must-throw|--must-pass] [--out FILE]
//   --selftest
//
// Writing: only the scratch file named by --out, never the target.

const fs = require('fs')
const os = require('os')
const path = require('path')
const { spawnSync } = require('child_process')

const Q = String.fromCharCode(39)
const argv = process.argv.slice(2)
const CMD = argv[0] || '--help'

function opt(name, dflt) {
  const i = argv.indexOf('--' + name)
  return i === -1 || i + 1 >= argv.length ? dflt : argv[i + 1]
}
function has(name) { return argv.includes('--' + name) }
function positional() {
  const out = []
  for (let i = 1; i < argv.length; i++) {
    if (String(argv[i]).slice(0, 2) === '--') { i++; continue }
    out.push(argv[i])
  }
  return out
}

// latin1 maps byte <-> char 1:1: a string offset IS a byte offset and no byte is
// lost to a UTF-8 decode error on a binary blob.
function readBlob(file) { return fs.readFileSync(file, 'latin1') }

// Raw bundle bytes in stdout inject NUL into the session transcript, and one NUL
// makes grep treat that log as binary -- it stops being searchable.
function printable(s) {
  return String(s)
    .replace(/\r\n/g, '\\r\\n')
    .replace(/[\r\n]/g, '\\n')
    .replace(/\t/g, '\\t')
    .replace(/[^\x20-\x7e]/g, '.')
}

function cmdFind() {
  const p = positional()
  const file = p[0]
  const pattern = p[1]
  if (!file || pattern === undefined) {
    console.log('usage: find <file> <literal> [--ctx N] [--max M] [--out FILE]')
    return 2
  }
  if (!fs.existsSync(file)) { console.log('ERROR not found: ' + file); return 2 }
  const ctx = Number(opt('ctx', 300))
  const max = Number(opt('max', 5))
  const src = readBlob(file)

  let total = 0
  const windows = []
  let i = -1
  while ((i = src.indexOf(pattern, i + 1)) !== -1) {
    if (windows.length < max) {
      const a = Math.max(0, i - ctx)
      const b = Math.min(src.length, i + pattern.length + ctx)
      windows.push({ offset: i, text: printable(src.slice(a, b)) })
    }
    total++
  }

  console.log('file=' + file + ' bytes=' + src.length)
  console.log('pattern=' + JSON.stringify(pattern) + ' hits=' + total)
  if (total === 0) {
    console.log('VERDICT: absent at byte level -- NOT yet proof the app lacks this. Minified bundles')
    console.log('rename identifiers and drop whitespace: search a STRING LITERAL copied verbatim from')
    console.log('the error text (try both quote styles), never a pretty-printed identifier.')
    return 1
  }
  console.log('printed=' + windows.length + ' of ' + total)
  const out = opt('out', null)
  if (out) {
    const body = windows.map((w) => '=== offset ' + w.offset + ' ===\n' + w.text).join('\n') + '\n'
    fs.writeFileSync(out, body, 'latin1')
    console.log('wrote=' + out + ' bytes=' + body.length + ' -- grep -n it, do not dump it into context')
    return 0
  }
  for (const w of windows) console.log('--- offset ' + w.offset + ' ---\n' + w.text)
  return 0
}

// Balanced region from an opening bracket. Skips strings, template literals and
// comments. Regex literals are NOT recognised, so a brace inside /.../ can skew
// the depth -- the compile gate is what catches that, and it fails loudly.
function matchRegion(src, start) {
  const close = { '(': ')', '{': '}', '[': ']' }
  const stack = []
  let state = null
  for (let i = start; i < src.length; i++) {
    const c = src[i]
    if (state) {
      if (c === '\\') { i++; continue }
      if (state === 'sq' && c === Q) state = null
      else if (state === 'dq' && c === '"') state = null
      else if (state === 'tpl' && c === '`') state = null
      else if (state === 'lc' && (c === '\n' || c === '\r')) state = null
      else if (state === 'bc' && c === '*' && src[i + 1] === '/') { i++; state = null }
      continue
    }
    if (c === Q) { state = 'sq'; continue }
    if (c === '"') { state = 'dq'; continue }
    if (c === '`') { state = 'tpl'; continue }
    if (c === '/' && src[i + 1] === '/') { state = 'lc'; i++; continue }
    if (c === '/' && src[i + 1] === '*') { state = 'bc'; i++; continue }
    if (close[c]) stack.push(close[c])
    else if (c === ')' || c === '}' || c === ']') {
      if (stack.pop() !== c) return -1
      if (!stack.length) return i
    }
  }
  return -1
}

function skipSpace(src, i) {
  while (i < src.length && /\s/.test(src[i])) i++
  return i
}

// Slice the WHOLE function, never a fragment. Cutting mid-body is the trap this
// encodes: the re-declared const died with "already been declared" under eval.
function extractFunction(src, start) {
  let i = start
  while (i < src.length && src[i] !== '(' && src[i] !== '{' && src[i] !== '[') {
    if (src[i] === ';' || src[i] === '}') return null
    i++
  }
  if (i >= src.length) return null
  const end = matchRegion(src, i)
  if (end < 0) return null
  const j = skipSpace(src, end + 1)
  if (src.slice(j, j + 2) === '=>') {
    let k = j
    while (k < src.length && !',;)'.includes(src[k]) && src[k] !== '\n' && src[k] !== '\r') k++
    return src.slice(start, k)
  }
  if (src[j] === '{') {
    const end2 = matchRegion(src, j)
    if (end2 < 0) return null
    return src.slice(start, end2 + 1)
  }
  return src.slice(start, end + 1)
}

function headPatterns(name) {
  return [
    'function ' + name + '(', 'function ' + name + ' (',
    name + '=function(', name + '=function (', name + '= function (',
    name + ':function(', 'const ' + name + '=function(', 'var ' + name + '=function(',
    'let ' + name + '=function(', 'const ' + name + '=(', 'var ' + name + '=(',
    'const ' + name + ' = (', name + '=(',
  ]
}

function locate(src, name, hint) {
  const cands = []
  for (const p of headPatterns(name)) {
    let i = -1
    while ((i = src.indexOf(p, i + 1)) !== -1) cands.push({ i, p })
  }
  if (cands.length && hint !== undefined && !Number.isNaN(hint)) {
    cands.sort((a, b) => Math.abs(a.i - hint) - Math.abs(b.i - hint))
  }
  return cands
}

function resolveStart(src) {
  const name = opt('name', null)
  const offsetArg = opt('offset', null)
  if (offsetArg !== null) return Number(offsetArg)
  if (!name) return NaN
  const cands = locate(src, name, Number(opt('hint', NaN)))
  if (!cands.length) {
    console.log('heads=0 name=' + name)
    console.log('VERDICT: no declaration head -- minified away. Run `find` on a string literal, take')
    console.log('its offset, then walk --offset backwards until the region balances at a real head.')
    return NaN
  }
  console.log('candidate_heads=' + cands.length + ' -> ' + cands.slice(0, 6).map((c) => c.i + ':' + printable(c.p)).join(' , '))
  return cands[0].i
}

function cmdFn() {
  const file = positional()[0]
  if (!file) { console.log('usage: fn <file> --name IDENT [--hint N] [--out FILE] | fn <file> --offset N'); return 2 }
  if (!fs.existsSync(file)) { console.log('ERROR not found: ' + file); return 2 }
  const src = readBlob(file)
  const start = resolveStart(src)
  if (Number.isNaN(start)) return 2

  const snip = extractFunction(src, start)
  if (snip === null) {
    console.log('start=' + start + ' UNBALANCED from this offset')
    console.log('VERDICT: you are inside a body, not at a declaration head -- eval-ing this re-declares')
    console.log('an outer const. Move --offset backwards to the head.')
    return 1
  }
  let syntax = 'OK'
  try { new Function(snip) } catch (e) { syntax = 'ERR ' + String(e.message).slice(0, 140) }
  console.log('start=' + start + ' len=' + snip.length + ' syntax=' + syntax)
  const out = opt('out', null)
  if (out) { fs.writeFileSync(out, snip, 'utf8'); console.log('wrote=' + out) }
  else console.log(printable(snip).slice(0, 3000))
  return syntax === 'OK' ? 0 : 1
}

// The payoff step: run the SHIPPED logic against candidate inputs instead of
// reading it. Deps come from a file, not the shell -- quoting a JS expression
// through bash is how the patched copy silently loses characters.
function cmdExec() {
  const file = positional()[0]
  const asName = opt('as', null)
  if (!file || !asName) {
    console.log('usage: exec <file> --offset N --as NAME [--deps-file F] [--call EXPR] [--must-throw|--must-pass] [--out FILE]')
    return 2
  }
  if (!fs.existsSync(file)) { console.log('ERROR not found: ' + file); return 2 }
  const src = readBlob(file)
  const start = resolveStart(src)
  if (Number.isNaN(start)) return 2
  const snip = extractFunction(src, start)
  if (snip === null) { console.log('start=' + start + ' UNBALANCED -- fix the offset before executing'); return 1 }

  // Accept deps as SEVERAL --deps-file arguments and join them here. Piping the
  // extracted pieces through `cat a b > deps` glues them with no separator, so a
  // sliced class expression abuts the next function ("}function f(){") and the
  // deps file itself stops parsing -- the join must not be the operator's job.
  const depFiles = []
  for (let i = 0; i < argv.length; i++) if (argv[i] === '--deps-file' && argv[i + 1]) depFiles.push(argv[i + 1])
  const missingDeps = depFiles.filter((f) => !fs.existsSync(f))
  if (missingDeps.length) { console.log('DEPS_MISSING ' + missingDeps.join(' , ')); return 1 }
  const deps = depFiles.map((f) => readBlob(f)).join(';\n')
  // Join with ';\n' on purpose: a sliced class/const expression carries no
  // terminating semicolon, so plain concatenation yields "}function f(){" -- a
  // syntax error that looks like a bad slice but is the join.
  const body = deps + ';\n' + snip + ';\nreturn ' + asName + ';'
  let made
  try {
    made = new Function(body)()
  } catch (e) {
    console.log('COMPILE=ERR ' + String(e.message).slice(0, 200))
    console.log('VERDICT: missing dependency or wrong slice. Add the const/util it references to --deps-file (a wrong stub that merely compiles is worse: it fakes a pass).')
    if (has('show-body')) console.log(printable(body).slice(0, 2000))
    return 1
  }
  console.log('COMPILE=OK type=' + typeof made + ' deps=' + (depFiles.length ? depFiles.length + ' file(s)' : 'none'))
  const call = opt('call', null)
  if (!call) { console.log('NO-CALL: add --call EXPR to exercise it, e.g. --call ' + Q + 'f({kind:' + Q + 'x' + Q + '})' + Q); return 0 }

  let outcome, threw = false
  try {
    // evaluate the call INSIDE the generated body, so it can name the shipped
    // function directly -- binding it as a parameter instead leaves the real
    // identifier unbound and reports a ReferenceError as if the app threw it.
    outcome = new Function(deps + ';\n' + snip + ';\nreturn (' + call + ');')()
    outcome = JSON.stringify(outcome) === undefined ? String(outcome) : JSON.stringify(outcome)
  } catch (e) {
    threw = true
    outcome = String(e && e.message ? e.message : e)
  }
  console.log('call=' + printable(call).slice(0, 200))
  console.log((threw ? 'THREW=' : 'RESULT=') + printable(outcome).slice(0, 1000))
  const out = opt('out', null)
  if (out) fs.writeFileSync(out, body, 'utf8')
  // A throw is usually the EVIDENCE you wanted (the shipped validator rejecting a
  // shape), so it is not a script error by default -- assert which one you expect.
  if (has('must-throw') && !threw) { console.log('ASSERTION FAILED: expected a throw, it passed'); return 1 }
  if (has('must-pass') && threw) { console.log('ASSERTION FAILED: expected a pass, it threw'); return 1 }
  return 0
}

function run(args) {
  const r = spawnSync(process.execPath, [__filename].concat(args), { encoding: 'latin1' })
  return { status: r.status, out: String(r.stdout || '') }
}

// grep MUST be driven through a shell here: spawnSync without a shell hands the
// argument straight to MSYS, which brace-expands .{0,200} into two bogus file
// operands and exits 2. Counting stdout lines alone would then read as "no
// matches" -- the false negative this whole skill exists to kill.
function grepSh(expr, file) {
  const r = spawnSync('bash', ['-c', expr + " '" + file + "'"], { encoding: 'latin1' })
  return { status: r.status, out: String(r.stdout || ''), err: String(r.stderr || '') }
}
// 0 = matched, 1 = genuinely no match, >=2 = it never ran. Only the first two
// answers mean anything about the file's contents.
function grepRan(r) {
  if (r.status === null || r.status > 1) return 'grep did not run (exit ' + r.status + '): ' + printable(r.err).slice(0, 100)
  return false
}

function cmdSelftest() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asar-peek-selftest-'))
  const fx = path.join(dir, 'bundle.asar')
  // Every line is short, so a fixed-width grep context can NEVER be satisfied ->
  // grep -aoP '.{200}MARK.{200}' MUST find nothing. Two MARKs share one line, so
  // grep -c (lines) MUST disagree with grep -ao | wc -l (occurrences).
  const body = [
    'const K=1',
    'function pick(a){return a===' + Q + 'x' + Q + '?1:2}',
    'const mk=(v)=>v+1',
    'function outer(z){const inner=(y)=>{return y+z};return inner}',
    'function boom(x){throw new Error(' + Q + 'BOOMED' + Q + '+String(x))}',
    'function needsK(v){return v+K}',
    'function bad(){throw new E(' + Q + 'E_THREW' + Q + ')}',
    'A MARK B MARK C',
    'MARK tail',
    'const done = pick(' + Q + 'x' + Q + ')',
  ].join('\n') + '\n'
  fs.writeFileSync(fx, body, 'latin1')
  const deps = path.join(dir, 'deps.js')
  fs.writeFileSync(deps, 'const K=1\n', 'utf8')

  const results = []
  const check = (label, fn) => {
    try {
      const r = fn()
      if (r === true) results.push(['PASS', label])
      else if (r === 'NO-RUN') results.push(['NO-RUN', label])
      else results.push(['FAIL', label + ' :: ' + r])
    } catch (e) {
      results.push(['FAIL', label + ' :: threw ' + String(e.message).slice(0, 120)])
    }
  }
  const grepReady = () => {
    const v = spawnSync('grep', ['--version'], { encoding: 'latin1' })
    return v.status === 0 && /GNU grep/.test(v.stdout || '')
  }

  check('find counts every occurrence incl. same-line repeats (3)', () => {
    const r = run(['find', fx, 'MARK'])
    return (r.status === 0 && /hits=3/.test(r.out)) || 'exit=' + r.status + ' out=' + printable(r.out).slice(0, 100)
  })
  check('absent literal exits 1 -- the judge can fail', () => {
    const r = run(['find', fx, 'NOT_PRESENT_XYZ'])
    return r.status === 1 || 'exit=' + r.status
  })
  check('grep -c counts LINES(2) != grep -o counts OCCURRENCES(3)', () => {
    if (!grepReady()) return 'NO-RUN'
    const c = grepSh('grep -aoc MARK', fx)
    const ran = grepRan(c)
    if (ran) return ran
    const o = grepSh('grep -ao MARK', fx)
    const ran2 = grepRan(o)
    if (ran2) return ran2
    const occ = (o.out || '').split('\n').filter(Boolean).length
    return (String(c.out).trim() === '2' && occ === 3) || 'lines=' + String(c.out).trim() + ' occ=' + occ
  })
  check('fixed-width grep context: exit 1 (真无匹配) not 2, and 0 lines', () => {
    if (!grepReady()) return 'NO-RUN'
    const fixed = grepSh('grep -aoP ' + Q + '.{200}MARK.{200}' + Q, fx)
    const ran = grepRan(fixed)
    if (ran) return ran
    const loose = grepSh('grep -aoP ' + Q + '.{0,200}MARK.{0,200}' + Q, fx)
    const ran2 = grepRan(loose)
    if (ran2) return ran2
    const fl = (fixed.out || '').split('\n').filter(Boolean).length
    const ll = (loose.out || '').split('\n').filter(Boolean).length
    return (fixed.status === 1 && fl === 0 && loose.status === 0 && ll > 0) ||
      'fixed exit=' + fixed.status + ' lines=' + fl + ' loose exit=' + loose.status + ' lines=' + ll
  })
  check('grep driven without a shell exits 2 -- counted as NOT RUN, never as zero hits', () => {
    if (!grepReady()) return 'NO-RUN'
    const bare = spawnSync('grep', ['-aoP', '.{0,200}MARK.{0,200}', fx], { encoding: 'latin1' })
    const misread = (String(bare.stdout || '').split('\n').filter(Boolean).length === 0)
    return (bare.status >= 2 && misread) ||
      'expected exit>=2 with empty stdout, got exit=' + bare.status + ' lines=' + printable(String(bare.stdout)).slice(0, 60)
  })
  check('fn --name yields a runnable function (pick x=1 q=2)', () => {
    const src = readBlob(fx)
    const snip = extractFunction(src, src.indexOf('function pick('))
    if (!snip) return 'unbalanced'
    const f = new Function(snip + ';return pick;')()
    return (f('x') === 1 && f('q') === 2) || 'bad result'
  })
  check('fn grabs arrow body (mk(1)=2)', () => {
    const src = readBlob(fx)
    const snip = extractFunction(src, src.indexOf('const mk=('))
    if (!snip) return 'unbalanced'
    const f = new Function(snip + ';return mk;')()
    return f(1) === 2 || 'got ' + f(1)
  })
  check('nested braces close only at the OUTER function end (no early slice)', () => {
    const src = readBlob(fx)
    const snip = extractFunction(src, src.indexOf('function outer('))
    if (!snip) return 'unbalanced'
    return snip.trim().endsWith('return inner}') || 'got ' + printable(snip).slice(-40)
  })
  check('fn from mid-body offset is UNBALANCED, not silent garbage', () => {
    const src = readBlob(fx)
    const snip = extractFunction(src, src.indexOf('return a==='))
    return snip === null || 'got ' + printable(String(snip)).slice(0, 60)
  })
  check('exec runs shipped code and prints RESULT', () => {
    const r = run(['exec', fx, '--name', 'pick', '--as', 'pick', '--deps-file', deps, '--call', 'pick(' + Q + 'x' + Q + ')'])
    return (r.status === 0 && /COMPILE=OK/.test(r.out) && /RESULT=1/.test(r.out)) || 'exit=' + r.status + ' out=' + printable(r.out).slice(0, 160)
  })
  check('exec reports the shipped throw as EVIDENCE (exit 0, THREW=BOOMED1)', () => {
    const r = run(['exec', fx, '--name', 'boom', '--as', 'boom', '--call', 'boom(1)'])
    return (r.status === 0 && /THREW=.*BOOMED1/.test(r.out)) || 'exit=' + r.status + ' out=' + printable(r.out).slice(0, 160)
  })
  check('exec --must-pass turns that throw red (assertion is wired)', () => {
    const r = run(['exec', fx, '--name', 'boom', '--as', 'boom', '--call', 'boom(1)', '--must-pass'])
    return (r.status === 1 && /ASSERTION FAILED/.test(r.out)) || 'exit=' + r.status
  })
  check('exec --must-throw turns a clean return red (both directions bite)', () => {
    const r = run(['exec', fx, '--name', 'pick', '--as', 'pick', '--deps-file', deps, '--call', 'pick(' + Q + 'x' + Q + ')', '--must-throw'])
    return (r.status === 1 && /ASSERTION FAILED/.test(r.out)) || 'exit=' + r.status + ' out=' + printable(r.out).slice(0, 160)
  })
  check('missing dep shows as THREW at call time, not a silent pass', () => {
    const r = run(['exec', fx, '--name', 'needsK', '--as', 'needsK', '--call', 'needsK(1)'])
    return (r.status === 0 && /THREW=.*K is not defined/.test(r.out)) || 'exit=' + r.status + ' out=' + printable(r.out).slice(0, 200)
  })
  check('same call passes once the dep is supplied (deps-file wires up)', () => {
    const r = run(['exec', fx, '--name', 'needsK', '--as', 'needsK', '--deps-file', deps, '--call', 'needsK(1)', '--must-pass'])
    return (r.status === 0 && /RESULT=2/.test(r.out)) || 'exit=' + r.status + ' out=' + printable(r.out).slice(0, 200)
  })
  // regression for the defect found by following this skill's own docs verbatim:
  // `cat dep-a dep-b > deps` glues a semicolon-less class expression straight onto
  // the next function ("}function isObj()"), so the DEPS FILE stops parsing while
  // the slice itself is fine. Both directions are asserted -- the safe shape must
  // pass and the glued shape must be caught, or this check proves nothing.
  check('repeated --deps-file joins safely; a glued deps file is caught as COMPILE=ERR', () => {
    const dA = path.join(dir, 'dep-class.js')
    const dB = path.join(dir, 'dep-fn.js')
    fs.writeFileSync(dA, 'var E = class extends Error {\n\tname = ' + Q + 'E' + Q + ';\n}', 'utf8')
    fs.writeFileSync(dB, 'function isObj(v){return typeof v===' + Q + 'object' + Q + '}', 'utf8')
    const ok = run(['exec', fx, '--name', 'bad', '--as', 'bad', '--deps-file', dA, '--deps-file', dB, '--call', 'bad()'])
    if (!(ok.status === 0 && /COMPILE=OK/.test(ok.out) && /THREW=.*E_THREW/.test(ok.out))) {
      return 'safe shape broken: exit=' + ok.status + ' ' + printable(ok.out).slice(0, 160)
    }
    const glued = path.join(dir, 'dep-glued.js')
    fs.writeFileSync(glued, fs.readFileSync(dA, 'utf8') + fs.readFileSync(dB, 'utf8'), 'utf8')
    const bad = run(['exec', fx, '--name', 'bad', '--as', 'bad', '--deps-file', glued, '--call', 'bad()'])
    return (bad.status === 1 && /COMPILE=ERR/.test(bad.out)) ||
      'glued deps must fail to parse, got exit=' + bad.status + ' ' + printable(bad.out).slice(0, 160)
  })
  check('printable strips NUL and keeps newline markers', () => {
    const s = printable('a\x00b\nc')
    return (s.indexOf('\x00') === -1 && s === 'a.b\\nc') || JSON.stringify(s)
  })
  check('find --out writes full windows and keeps stdout short', () => {
    const o = path.join(dir, 'w.txt')
    const r = run(['find', fx, 'MARK', '--ctx', '4', '--out', o])
    return (r.status === 0 && fs.existsSync(o) && /offset/.test(fs.readFileSync(o, 'latin1'))) || 'exit=' + r.status
  })

  const counts = { PASS: 0, FAIL: 0, 'NO-RUN': 0 }
  for (const [k, label] of results) {
    counts[k]++
    console.log(k + '  ' + label)
  }
  console.log('SELFTEST pass=' + counts.PASS + ' fail=' + counts.FAIL + ' no-run=' + counts['NO-RUN'])
  if (counts['NO-RUN']) console.log('NOTE: NO-RUN items were NOT verified (tool absent). Do not read this run as fully green.')
  console.log('scratch=' + dir)
  return counts.FAIL ? 1 : 0
}

const DISPATCH = { find: cmdFind, fn: cmdFn, exec: cmdExec, '--selftest': cmdSelftest }
const H = [
  'asar-peek -- read-only forensics on packed Electron bundles (find | fn | exec | --selftest)',
  '  find <file> <literal> [--ctx N] [--max M] [--out FILE]',
  '  fn   <file> --name IDENT [--hint N] [--out FILE]  |  fn <file> --offset N',
  '  exec <file> --offset N|--name IDENT --as NAME [--deps-file F] [--call EXPR] [--must-throw|--must-pass]',
  '  --selftest',
]

let code
if (CMD === '--help' || CMD === '-h' || CMD === 'help') { console.log(H.join('\n')); code = 0 }
else if (DISPATCH[CMD]) code = DISPATCH[CMD]()
else { console.log(H.join('\n')); console.log('ERROR unknown command: ' + CMD); code = 2 }
process.exitCode = code === undefined ? 0 : code
