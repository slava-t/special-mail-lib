/* eslint camelcase: ["error", {properties: "never"}] */
const assert = require('assert').strict;
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const zlib = require('zlib');
const crypto = require('crypto');
const {spawnSync} = require('child_process');
const policy = require('../../scripts/check-dependency-policy');

const ROOT = path.join(__dirname, 'fixtures/dependency-policy');
const SCRIPT = path.resolve(__dirname,
  '../../scripts/check-dependency-policy.js');
const N = '@dep-policy-fixture/';
const NOW = Date.parse('2026-09-05T00:00:00Z');
const DAY = 86400000;
const BULK = '/-/npm/v1/security/advisories/bulk';
const empty = {schema_version: 1, upgrade_record: null, waivers: []};
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const clone = value => JSON.parse(JSON.stringify(value));
const encode = value => Buffer.from(JSON.stringify(value));
const bytes = (name, file) => fs.readFileSync(path.join(ROOT, name, file));
const fixture = name => {
  const pair = {manifest: bytes(name, 'package.json'),
    lockfile: bytes(name, 'package-lock.json')};
  return {pair, state: policy.stateFromPair(pair),
    report: JSON.parse(bytes(name, 'audit.json'))};
};
const ledger = value => policy.readLedger(encode(value));
const dated = age => new Date(NOW - age).toISOString();
const changes = (name, edit) => {
  const item = fixture(name);
  const manifest = JSON.parse(item.pair.manifest);
  const lock = JSON.parse(item.pair.lockfile);
  edit(manifest, lock);
  return {manifest: encode(manifest), lockfile: encode(lock)};
};
const run = async (afterName, config = {}) => {
  const before = fixture(config.before || 'shared-before');
  const after = fixture(afterName);
  const lookedUp = [];
  const publish = name => {
    lookedUp.push(name);
    if (config.publish) { return config.publish(name); }
    const time = Object.fromEntries([...after.state.pairs.values()]
        .filter(entry => entry.package === name)
        .map(entry => [entry.version,
          dated((config.ages?.[name] ?? 30) * DAY)]));
    return {name, time};
  };
  const result = await policy.evaluate(before.state, after.state,
    [before.report, after.report],
    ledger(config.ledger || empty), publish, NOW);
  return {result, lookedUp};
};
const temps = [];
const temporary = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sml-policy-test-'));
  temps.push(dir);
  return dir;
};
const prepared = (beforeName = 'shared-before', afterName = 'fixed-all') => {
  const root = temporary();
  const project = path.join(root, 'proposed');
  const baseline = path.join(root, 'baseline');
  for (const [dir, name] of [[project, afterName], [baseline, beforeName]]) {
    fs.mkdirSync(dir);
    for (const file of ['package.json', 'package-lock.json']) {
      fs.writeFileSync(path.join(dir, file), bytes(name, file));
    }
  }
  fs.mkdirSync(path.join(project, 'ci2/policy'), {recursive: true});
  fs.writeFileSync(path.join(project, 'ci2/policy/dependency-policy.yaml'),
    encode(empty));
  const record = {schema_version: 1, run_id: '1'.repeat(64),
    target_ref: 'refs/remotes/origin/policy $(literal)',
    target_commit: '2'.repeat(40), review_commit: '3'.repeat(40),
    baseline_ref: '4'.repeat(40), baseline_commit: '4'.repeat(40),
    manifest_ref: '4'.repeat(40), lockfile_ref: '4'.repeat(40),
    merge_base_verified: true, lockfile_version: 3,
    manifest_sha256: hash(bytes(beforeName, 'package.json')),
    lockfile_sha256: hash(bytes(beforeName, 'package-lock.json')),
    review_manifest_sha256: hash(bytes(afterName, 'package.json')),
    review_lockfile_sha256: hash(bytes(afterName, 'package-lock.json'))};
  const save = () => fs.writeFileSync(path.join(baseline, 'record.json'),
    encode(record));
  save();
  const env = {...process.env, SML_BASELINE_RUN_ID: record.run_id,
    SML_BASELINE_TARGET_B64: Buffer.from(record.target_ref).toString('base64')};
  return {root, project, baseline, record, save, env};
};
const cli = (input, extra = []) => spawnSync(process.execPath,
  [SCRIPT, '--project-dir', input.project, '--baseline-dir', input.baseline,
    ...extra], {env: input.env, encoding: 'utf8', timeout: 15000});
const waiverFor = (drivers, scope, entries) => ({
  id: 'fixture-authorization', scope, admitted_entries: entries, drivers,
  user_statement: 'Synthetic test authorization; never a project waiver.',
  date: '2026-09-01T00:00:00Z',
});
const withWaiver = waiver => ({schema_version: 1, waivers: [waiver],
  upgrade_record: {waiver_refs: [waiver.id],
    upgrades: waiver.scope.kind === 'upgrade' ? [waiver.scope] : []}});
const upgrade = {kind: 'upgrade', package: 'minimist',
  from_version: '1.2.0', target_version: '1.2.8'};
const young = {ages: {'minimist': 3, [N + 'fresh']: 3}};
const post = (url, value, gzip = false) => new Promise((resolve, reject) => {
  const raw = encode(value);
  const req = http.request(url, {method: 'POST', headers: {
    'content-type': 'application/json',
    ...(gzip ? {'content-encoding': 'gzip'} : {}),
  }}, res => {
    const chunks = [];
    res.on('data', chunk => chunks.push(chunk));
    res.on('end', () => resolve({status: res.statusCode,
      body: Buffer.concat(chunks)}));
  });
  req.on('error', reject);
  req.end(gzip ? zlib.gzipSync(raw) : raw);
});
const get = url => new Promise((resolve, reject) => {
  http.get(url, res => {
    const chunks = [];
    res.on('data', chunk => chunks.push(chunk));
    res.on('end', () => resolve({status: res.statusCode,
      body: Buffer.concat(chunks)}));
  }).on('error', reject);
});
const upstream = events => (url, options = {}) => {
  events.push({url, method: options.method || 'GET', body: options.body});
  if (url.endsWith(BULK)) { return bytes('registry', 'bulk.json'); }
  assert.equal(url, 'https://registry.npmjs.org/minimist');
  return bytes('registry', 'minimist.json');
};

describe('dependency policy', function() {
  this.timeout(30000);
  afterEach(function() {
    while (temps.length) {
      fs.rmSync(temps.pop(), {recursive: true, force: true});
    }
  });

  it('F1 checks the advisory-free transitive entry', async function() {
    const {result} = await run('fixed-all', {ages: {[N + 'fresh']: 3}});
    assert.equal(result.exit_code, 1);
    assert.deepEqual(result.entries.filter(e => e.status === 'violation')
        .map(e => e.package), [N + 'fresh']);
  });
  it('F2 derives drivers after complete remediation', async function() {
    assert.deepEqual(fixture('fixed-all').report.vulnerabilities, {});
    const {result, lookedUp} = await run('fixed-all', {ages: {minimist: 3}});
    assert.equal(result.exit_code, 1);
    assert.equal(result.drivers.derived.length, 2);
    assert(lookedUp.includes('minimist'));
    assert(result.drivers.derived.every(e => e.severity === 'critical'));
  });
  it('F3a preserves chains to an unchanged hoisted copy', async function() {
    const {result} = await run('fixed-partial', {ages: {[N + 'fresh']: 3}});
    assert.equal(result.exit_code, 1);
    assert.deepEqual(result.drivers.derived.map(e => e.chain),
      [[N + 'a', 'minimist']]);
    const report = fixture('fixed-partial').report;
    assert.deepEqual(report.vulnerabilities.minimist.nodes,
      ['node_modules/minimist']);
  });
  it('F3b keys instances by vulnerable version', async function() {
    const {result} = await run('vulnerable-partial',
      {ages: {[N + 'fresh']: 3}});
    assert.equal(result.exit_code, 1);
    assert.deepEqual(result.drivers.derived.map(e => [e.version, e.chain]),
      [['1.2.0', [N + 'a', 'minimist']]]);
    const report = fixture('vulnerable-partial').report.vulnerabilities;
    assert.equal(report[N + 'a'].range, '');
    assert.equal(typeof report[N + 'a'].via[0], 'string');
    assert.equal(report.minimist.nodes.length, 2);
  });
  it('F3c ignores an intermediate version bump', async function() {
    const {result, lookedUp} = await run('intermediate-bump',
      {ages: {[N + 'a']: 3}});
    assert.equal(result.outcome, 'unpoliced');
    assert.deepEqual(result.drivers.derived, []);
    assert.deepEqual(lookedUp, []);
  });
  it('F4 uses lock topology and advisory severity', async function() {
    const before = fixture('severity-before').report.vulnerabilities;
    assert.equal(before.request.severity, 'critical');
    assert.deepEqual(before.request.effects.sort(), [N + 'x', N + 'y']);
    assert.equal(before.request.nodes.length, 2);
    assert.deepEqual(before.request.via.filter(e => typeof e === 'object')
        .map(e => e.severity), ['moderate']);
    assert(before.request.via.includes('form-data'));
    const {result, lookedUp} = await run('severity-after',
      {before: 'severity-before', ages: {request: 3}});
    assert.equal(result.outcome, 'unpoliced');
    assert.equal(result.counts.before_instances -
      result.counts.after_instances, 1);
    assert.deepEqual(result.drivers.derived, []);
    assert.deepEqual(lookedUp, []);
  });
  it('retains all advisory and capture identities', function() {
    const identities = JSON.parse(fs.readFileSync(path.join(ROOT,
      'identities.json')));
    for (const [name, files] of Object.entries(identities)) {
      for (const [file, expected] of Object.entries(files)) {
        assert.equal(hash(bytes(name, file)), expected, name + '/' + file);
      }
    }
    const ids = new Set();
    for (const name of Object.keys(identities)) {
      for (const item of Object.values(fixture(name).report.vulnerabilities)) {
        for (const via of item.via) {
          if (typeof via === 'object') { ids.add(via.source); }
        }
      }
    }
    assert.deepEqual([...ids].sort(),
      [1096465, 1096727, 1097678, 1109540, 1120745]);
  });
  it('enumerates distinct severities and deduplicates same-severity objects',
    function() {
      const item = fixture('shared-before');
      const first = policy.instances(item.state, item.report);
      assert.equal(first.size, 4);
      const report = clone(item.report); // Deliberate duplicate input variant.
      report.vulnerabilities.minimist.via.push(
        clone(report.vulnerabilities.minimist.via[0])
      );
      assert.equal(policy.instances(item.state, report).size, 4);
    });
  it('walks root dev edges with equal policy coverage', async function() {
    const {result} = await run('collection-after',
      {before: 'collection-before', ages: {minimist: 3}});
    assert.equal(result.exit_code, 1);
    assert.deepEqual(result.drivers.derived[0].chain, ['minimist']);
  });
  it('walks optional and peer edges with alternate paths', function() {
    const before = fixture('edges-before');
    const after = fixture('edges-after');
    const pre = policy.instances(before.state, before.report);
    const postInstances = policy.instances(after.state, after.report);
    const chains = [...pre.values()].filter(e => e.package === 'minimist' &&
      e.severity === 'critical').map(e => JSON.stringify(e.chain));
    assert(chains.includes(JSON.stringify([N + 'a', 'minimist'])));
    assert(chains.includes(JSON.stringify([N + 'a', N + 'a', 'minimist'])));
    const later = [...postInstances.values()].map(e => JSON.stringify(e.chain));
    assert(!later.includes(JSON.stringify([N + 'a', 'minimist'])));
    assert(!later.includes(JSON.stringify([N + 'a', N + 'a', 'minimist'])));
    assert.equal(before.state.nodes.size, after.state.nodes.size);
  });
  it('bounds cycles by node and retains repeated names', function() {
    const item = fixture('edges-before');
    const chains = [];
    policy.walk(item.state, (node, chain) => chains.push(chain));
    assert(chains.some(chain => JSON.stringify(chain) ===
      JSON.stringify([N + 'a', N + 'a', N + 'b', 'minimist'])));
    assert(chains.every(chain => chain.length <= item.state.nodes.size - 1));
    assert(chains.length < 100);
  });
  it('supports v2 and rejects unsupported, absent and uncovered states',
    function() {
      const v2 = changes('shared-before', (manifest, lock) => {
        lock.lockfileVersion = 2;
      });
      assert.equal(policy.stateFromPair(v2).pairs.size, 3);
      const corruptions = [
        (m, l) => { l.lockfileVersion = 1; },
        (m, l) => { delete l.packages; },
        (m, l) => { delete l.packages['']; },
        (m, l) => { l.packages['node_modules/orphan'] = {version: '1.0.0'}; },
        (m, l) => { l.packages['node_modules/minimist'].link = true; },
        (m, l) => { l.packages['node_modules/minimist'].inBundle = true; },
        (m, l) => { l.packages['node_modules/minimist'].version = 'latest'; },
        (m, l) => {
          l.packages['node_modules/minimist'].resolved = 'file:foo';
        },
        (m, l) => { l.packages['node_modules/minimist'].name = 'alias'; },
        m => { m.dependencies = []; },
        (m, l) => { l.packages[''].dependencies = {}; },
      ];
      for (const edit of corruptions) {
        assert.throws(() =>
          policy.stateFromPair(changes('shared-before', edit)));
        assert.throws(() => policy.stateFromPair(changes('fixed-all', edit)));
      }
    });
  it('declarations only widen scope', async function() {
    const declared = {id: 'test-advisory',
      package: 'minimist', severity: 'high'};
    const value = {...empty, upgrade_record: {advisories: [declared]}};
    const widened = await run('intermediate-bump',
      {ledger: value, ages: {[N + 'a']: 3}});
    assert.equal(widened.result.exit_code, 1);
    assert.deepEqual(widened.result.drivers.declared, [declared]);
    const derived = await run('fixed-all',
      {ledger: {...empty, upgrade_record: {advisories: []}}, ...young});
    assert.equal(derived.result.exit_code, 1);
    assert.equal(derived.result.drivers.derived.length, 2);
  });
  it('polices incidental chain removal and ignores moved existing pairs',
    async function() {
      const {result} = await run('removal-after', {ages: {[N + 'fresh']: 3}});
      assert.equal(result.exit_code, 1);
      assert.deepEqual(result.drivers.derived.map(e => e.chain),
        [[N + 'a', 'minimist']]);
      assert.deepEqual(result.newly_introduced.map(e => e.package),
        [N + 'fresh']);
      const item = fixture('fixed-partial');
      assert(item.state.pairs.has(JSON.stringify(['minimist', '1.2.0'])));
    });
  it('uses run time and the exact 336-hour boundary', async function() {
    for (const [age, expected] of [[14 * DAY - 1000, 1], [14 * DAY, 0]]) {
      const {result} = await run('fixed-all', {
        ledger: {...empty, upgrade_record: {date: '2099-01-01T00:00:00Z'}},
        publish: () => ({time: {
          '1.2.8': dated(age), '1.0.0': dated(30 * DAY),
        }}),
      });
      assert.equal(result.exit_code, expected);
      assert.equal(result.check_time, '2026-09-05T00:00:00.000Z');
    }
  });
  it('fails unavailable, missing, invalid and future publication data',
    async function() {
      for (const data of [null, {}, {time: {}}, {time: {'1.2.8': 'bad'}},
        {time: {'1.2.8': '2026-02-30T00:00:00Z'}},
        {time: {'1.2.8': dated(-1)}}]) {
        const {result} = await run('fixed-all', {publish: () => data});
        assert.equal(result.exit_code, 2);
        assert(result.errors.length > 0);
      }
      const {result} = await run('fixed-all',
        {publish: () => { throw new Error('fixture network failure'); }});
      assert.equal(result.exit_code, 2);
    });
  it('reports known violations alongside metadata errors', async function() {
    const {result} = await run('fixed-all', {publish: name =>
      name === 'minimist' ? {time: {'1.2.8': dated(3 * DAY)}} : {}});
    assert.equal(result.exit_code, 2);
    const violations = result.entries.filter(e => e.status === 'violation');
    assert.equal(violations.length, 1);
    assert.equal(result.errors.length, 1);
  });
  it('matches per-upgrade waivers to exact entries and actual transitions',
    async function() {
      const {result: reference} = await run('fixed-all', young);
      const waiver = waiverFor(reference.drivers, upgrade,
        [{package: 'minimist', version: '1.2.8'}]);
      const value = withWaiver(waiver);
      const partial = await run('fixed-all', {...young, ledger: value});
      assert.equal(partial.result.exit_code, 1);
      assert.deepEqual(partial.result.entries
          .filter(e => e.status === 'violation')
          .map(e => e.package), [N + 'fresh']);
      waiver.admitted_entries.push({package: N + 'fresh', version: '1.0.0'});
      assert.equal((await run('fixed-all', {...young, ledger: value}))
          .result.exit_code, 0);
      for (const edit of [
        w => { w.scope.target_version = '1.2.9'; },
        w => { w.scope.from_version = '1.1.0'; },
        w => { w.admitted_entries[0].version = '^1.2.8'; },
        w => { w.admitted_entries[0].version = '1.2.9'; },
        w => { w.drivers.derived[0].chain = ['minimist']; },
        w => { w.user_statement = ''; },
        w => { w.date = '2099-01-01T00:00:00Z'; },
      ]) {
        const invalid = clone(waiver);
        edit(invalid);
        assert.equal((await run('fixed-all', {...young,
          ledger: withWaiver(invalid)})).result.exit_code, 1);
      }
    });
  it('requires references and unique IDs', async function() {
    const {result} = await run('fixed-all', young);
    const waiver = waiverFor(result.drivers, upgrade,
      [{package: 'minimist', version: '1.2.8'}]);
    const value = withWaiver(waiver);
    value.upgrade_record.waiver_refs = [];
    assert.equal((await run('fixed-all', {...young, ledger: value}))
        .result.exit_code, 1);
    value.waivers.push(clone(waiver));
    await assert.rejects(run('fixed-all', {...young, ledger: value}),
      /Duplicate waiver ID/);
  });
  it('never waives unknown publish time', async function() {
    const {result} = await run('fixed-all', young);
    const waiver = waiverFor(result.drivers, upgrade,
      [{package: 'minimist', version: '1.2.8'},
        {package: N + 'fresh', version: '1.0.0'}]);
    assert.equal((await run('fixed-all', {ledger: withWaiver(waiver),
      publish: () => ({})})).result.exit_code, 2);
  });
  it('allows exact no-upgrade and declaration-only change-set waivers',
    async function() {
      for (const [beforeName, afterName, declarations] of [
        ['shared-before', 'removal-after', []],
        ['declared-before', 'declared-after',
          [{id: 'fixture-driver', package: N + 'b', severity: 'high'}]],
      ]) {
        const value = {...empty, upgrade_record: {advisories: declarations}};
        const config = {before: beforeName, ledger: value,
          ages: {[N + 'fresh']: 3}};
        const {result} = await run(afterName, config);
        assert.equal(result.exit_code, 1);
        const waiver = waiverFor(result.drivers, {kind: 'change-set'},
          [{package: N + 'fresh', version: '1.0.0'}]);
        config.ledger = withWaiver(waiver);
        config.ledger.upgrade_record.advisories = declarations;
        assert.equal((await run(afterName, config)).result.exit_code, 0);
        waiver.drivers = {derived: [], declared: []};
        assert.equal((await run(afterName, config)).result.exit_code, 1);
      }
    });
  it('rejects change-set waivers for upgrades',
    async function() {
      const {result} = await run('fixed-all', young);
      const waiver = waiverFor(result.drivers, {kind: 'change-set'},
        result.newly_introduced);
      assert.equal((await run('fixed-all',
        {...young, ledger: withWaiver(waiver)}))
          .result.exit_code, 1);
    });
  it('validates consumed declarations but defers unpoliced waiver checks',
    async function() {
      for (const value of [{}, {...empty, schema_version: 2},
        {...empty, upgrade_record: {advisories: 'wrong'}},
        {...empty, upgrade_record: {advisories: [{}]}}]) {
        assert.throws(() => ledger(value));
      }
      assert.throws(() =>
        policy.readLedger(Buffer.from('schema_version: [bad')));
      const {result, lookedUp} = await run('intermediate-bump',
        {ledger: {...empty, waivers: 'invalid but unconsumed'}});
      assert.equal(result.exit_code, 0);
      assert.deepEqual(lookedUp, []);
    });

  it('binds complete baseline inputs to independent invocation identity',
    function() {
      const input = prepared();
      assert.equal(policy.validateBaseline(input.project, input.baseline,
        input.env).record.review_commit, input.record.review_commit);
      for (const edit of [
        r => { delete r.manifest_sha256; },
        r => { r.extra = true; },
        r => { r.merge_base_verified = false; },
        r => { r.baseline_ref = '5'.repeat(40); },
        r => { r.run_id = '9'.repeat(64); },
        r => { r.target_ref = 'wrong'; },
        r => { r.manifest_sha256 = '0'.repeat(64); },
        r => { r.review_lockfile_sha256 = '0'.repeat(64); },
        r => { r.lockfile_version = 1; },
      ]) {
        const item = prepared();
        edit(item.record);
        item.save();
        assert.throws(() => policy.validateBaseline(item.project,
          item.baseline, item.env));
        const result = cli(item);
        assert.equal(result.status, 2, result.stdout + result.stderr);
        assert(!result.stdout.includes('Advisory snapshot:'));
      }
    });
  it('rejects invalid, stale and missing baseline paths before collection',
    function() {
      for (const corrupt of [
        i => { delete i.env.SML_BASELINE_RUN_ID; },
        i => { i.env.SML_BASELINE_TARGET_B64 = '!!!!'; },
        i => { i.env.SML_BASELINE_TARGET_B64 = '/w=='; },
        i => { fs.unlinkSync(path.join(i.baseline, 'record.json')); },
        i => { fs.appendFileSync(path.join(i.baseline, 'package.json'), ' '); },
        i => {
          fs.appendFileSync(path.join(i.project, 'package-lock.json'), ' ');
        },
        i => { fs.writeFileSync(path.join(i.baseline, 'not-requested'), 'x'); },
        i => {
          const file = path.join(i.baseline, 'package.json');
          fs.unlinkSync(file);
          fs.symlinkSync(path.join(i.project, 'package.json'), file);
        },
      ]) {
        const input = prepared();
        corrupt(input);
        assert.throws(() => policy.validateBaseline(input.project,
          input.baseline, input.env));
        assert.equal(cli(input).status, 2);
      }
      const input = prepared();
      input.baseline = input.project;
      assert.equal(cli(input).status, 2);
    });
  it('rejects strict-ancestor ref substitutions', function() {
    const input = prepared();
    const gitDir = path.join(input.root, 'history');
    fs.mkdirSync(gitDir);
    const git = args => {
      const result = spawnSync('git', args, {cwd: gitDir, encoding: 'utf8',
        env: {...process.env, GIT_AUTHOR_NAME: 'Fixture',
          GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
          GIT_COMMITTER_NAME: 'Fixture',
          GIT_COMMITTER_EMAIL: 'fixture@example.invalid'}});
      assert.equal(result.status, 0, result.stderr);
      return result.stdout.trim();
    };
    git(['init', '-q', '-b', 'fixture']);
    git(['commit', '-q', '--allow-empty', '-m', 'Create A']);
    const a = git(['rev-parse', 'HEAD']);
    git(['commit', '-q', '--allow-empty', '-m', 'Create B']);
    const b = git(['rev-parse', 'HEAD']);
    assert.notEqual(a, b);
    assert.equal(git(['merge-base', '--all', a, b]), a);
    for (const key of ['baseline_ref', 'baseline_commit',
      'manifest_ref', 'lockfile_ref']) { input.record[key] = b; }
    input.record.target_commit = b;
    input.record.review_commit = b;
    assert.equal(git(['merge-base', '--all', b, b]), b);
    input.record.baseline_ref = a;
    input.save();
    assert.throws(() => policy.validateBaseline(input.project,
      input.baseline, input.env));
    assert.equal(cli(input).status, 2);
    for (const key of ['baseline_ref', 'baseline_commit',
      'manifest_ref', 'lockfile_ref']) { input.record[key] = a; }
    input.record.merge_base_verified = false;
    input.save();
    assert.throws(() => policy.validateBaseline(input.project,
      input.baseline, input.env));
    assert.equal(cli(input).status, 2);
  });
  it('rejects CLI misuse and missing ledger', function() {
    const input = prepared();
    for (const args of [['--clock', 'yesterday'], ['--project-dir'],
      ['--baseline-dir', input.baseline], ['--unknown', 'x']]) {
      const invalid = cli(input, args);
      assert.equal(invalid.status, 2);
      assert(invalid.stdout.includes('Usage:'));
    }
    const file = path.join(input.project, 'ci2/policy/dependency-policy.yaml');
    fs.unlinkSync(file);
    const result = cli(input);
    assert.equal(result.status, 2);
    assert(result.stdout.includes('dependency-policy.yaml'));
  });
  it('returns process statuses 0 and 1 with offline imports',
    function() {
      for (const [afterName, expected] of [['intermediate-bump', 0],
        ['fixed-all', 1]]) {
        const input = prepared('shared-before', afterName);
        const script = `
          const fs = require('fs');
          const checker = require(${JSON.stringify(SCRIPT)});
          const reports = ${JSON.stringify([fixture('shared-before').report,
    fixture(afterName).report])};
          checker.main(${JSON.stringify(['--project-dir', input.project,
    '--baseline-dir', input.baseline])}, {
            collect: async () => ({reports, snapshot: {id: 'offline-fixture'},
              publish: async () => ({time: {
                '1.0.0': new Date(Date.now() - 1000).toISOString(),
                '1.2.8': new Date(Date.now() - 1000).toISOString()
              }})})
          }).then(code => { process.exitCode = code; });
        `;
        const result = spawnSync(process.execPath, ['-e', script],
          {env: input.env, encoding: 'utf8', timeout: 15000});
        assert.equal(result.status, expected, result.stderr + result.stdout);
        if (expected === 1) {
          assert(result.stdout.includes('Removed instance:'));
          assert(result.stdout.includes('adoptable from'));
        }
        const evidence = result.stdout.match(/Evidence: (.+)/)[1];
        temps.push(evidence);
        assert.equal(JSON.parse(fs.readFileSync(path.join(evidence,
          'result.json'))).exit_code, expected);
      }
    });

  it('collects one snapshot with both real npm audits and full dev scope',
    async function() {
      const before = fixture('collection-before');
      const after = fixture('collection-after');
      const events = [];
      const old = {};
      for (const key of ['NODE_ENV', 'npm_config_omit', 'npm_config_offline']) {
        old[key] = process.env[key];
      }
      Object.assign(process.env, {NODE_ENV: 'production',
        npm_config_omit: 'dev,optional,peer', npm_config_offline: 'true'});
      try {
        const evidence = temporary();
        const captured = await policy.collect(
          before.state, after.state, evidence,
          {fetch: upstream(events)}
        );
        assert.equal(events.filter(e => e.method === 'POST').length, 1);
        assert.deepEqual(JSON.parse(events[0].body),
          {minimist: ['1.2.0', '1.2.8']});
        assert.equal(events.filter(e => e.method === 'GET').length, 1);
        const via = captured.reports[0].vulnerabilities.minimist.via;
        assert.equal(via.length, 2);
        assert.deepEqual(captured.reports[1].vulnerabilities, {});
        assert.equal(captured.snapshot.npm_version, '11.6.2');
        assert.equal(captured.snapshot.bulk_sha256, hash(bytes('registry',
          'bulk.json')));
        assert.equal((await captured.publish('minimist')).name, 'minimist');
        assert.equal(events.filter(e => e.method === 'GET').length, 1);
        const raw = fs.readFileSync(path.join(evidence, 'bulk-response.json'));
        assert.equal(hash(raw), captured.snapshot.bulk_sha256);
      } finally {
        for (const [key, value] of Object.entries(old)) {
          if (value === undefined) { delete process.env[key]; } else {
            process.env[key] = value;
          }
        }
      }
    });
  it('freezes upstream data and shares packument requests',
    async function() {
      const item = fixture('collection-before');
      const events = [];
      const fetch = upstream(events);
      let auditCount = 0;
      const evidence = temporary();
      const captured = await policy.collect(item.state, item.state, evidence, {
        fetch: (url, opts) => {
          if (events.some(e => e.url === url)) {
            throw new Error('Upstream changed after first request');
          }
          return fetch(url, opts);
        },
        audit: async args => {
          auditCount++;
          const bulk = await post(args.registry + BULK,
            item.state.payload, true);
          assert.equal(bulk.status, 200);
          const [a, b] = await Promise.all([get(args.registry + '/minimist'),
            get(args.registry + '/minimist')]);
          assert.equal(a.status, 200);
          assert(a.body.equals(b.body));
          return {code: 1, stdout: bytes('collection-before', 'audit.json'),
            stderr: Buffer.alloc(0)};
        },
      });
      assert.equal(auditCount, 2);
      assert.equal(events.length, 2);
      assert.equal(captured.reports.length, 2);
    });
  it('rejects packument errors swallowed by npm', async function() {
    const before = fixture('collection-before');
    const after = fixture('collection-after');
    const evidence = temporary();
    await assert.rejects(policy.collect(before.state, after.state, evidence, {
      fetch: url => {
        if (url.endsWith(BULK)) { return bytes('registry', 'bulk.json'); }
        throw new Error('Fixture packument outage');
      },
    }), /Registry adapter failure/);
  });
  it('rejects collection failures and incomplete inventories',
    async function() {
      const item = fixture('collection-before');
      for (const mode of ['missing', 'narrowed', 'endpoint', 'failed',
        'malformed', 'counts', 'changed-input']) {
        const evidence = temporary();
        await assert.rejects(policy.collect(item.state, item.state, evidence, {
          fetch: upstream([]),
          audit: async args => {
            if (mode !== 'missing') {
              await post(args.registry + BULK,
                mode === 'narrowed' ? {} : item.state.payload);
            }
            if (mode === 'endpoint') { await get(args.registry + '/other'); }
            if (mode === 'changed-input') {
              fs.appendFileSync(path.join(args.directory, 'package.json'), ' ');
            }
            const report = clone(item.report);
            if (mode === 'counts') { report.metadata.dependencies.total = 0; }
            return {code: mode === 'failed' ? 2 : 1,
              stdout: mode === 'malformed' ?
                Buffer.from('oops') : encode(report),
              stderr: Buffer.alloc(0)};
          },
        }));
      }
      for (const raw of [Buffer.from('not JSON'), encode([]),
        encode({minimist: [{id: 1}]})]) {
        await assert.rejects(policy.collect(item.state, item.state, temporary(),
          {fetch: () => raw}));
      }
    });
  it('rejects malformed audit objects before scope', function() {
    const item = fixture('shared-before');
    for (const edit of [
      r => { r.auditReportVersion = 1; },
      r => { r.metadata = {}; },
      r => { r.vulnerabilities.minimist.via[0].range = 'garbage('; },
      r => { r.vulnerabilities.minimist.via[0].severity = 'unknown'; },
      r => { r.vulnerabilities.minimist.nodes = ['node_modules/unknown']; },
    ]) {
      const report = clone(item.report); // Intentional corrupted report input.
      edit(report);
      assert.throws(() => policy.instances(item.state, report));
    }
  });

  it('removes a dev-root chain while every node remains reachable',
    async function() {
      const {result} = await run('dev-chain-after',
        {before: 'dev-chain-before'});
      assert.equal(result.drivers.derived.length, 1);
      assert.deepEqual(result.drivers.derived[0].chain, [N + 'b', 'minimist']);
      assert.equal(result.counts.before_entries, result.counts.after_entries);
    });
  it('does not age-check moved versions or waive their chain upgrades broadly',
    async function() {
      const config = {before: 'moved-before', ages: {[N + 'fresh']: 3}};
      const {result, lookedUp} = await run('moved-after', config);
      assert.equal(result.exit_code, 1);
      assert.deepEqual(lookedUp, [N + 'fresh']);
      assert.deepEqual(result.newly_introduced,
        [{package: N + 'fresh', version: '1.0.0'}]);
      const waiver = waiverFor(result.drivers, {kind: 'change-set'},
        result.newly_introduced);
      assert.equal((await run('moved-after',
        {...config, ledger: withWaiver(waiver)})).result.exit_code, 1);
    });
  it('rechecks source bytes after advisory collection', async function() {
    const input = prepared();
    const previous = {};
    for (const key of ['SML_BASELINE_RUN_ID', 'SML_BASELINE_TARGET_B64']) {
      previous[key] = process.env[key];
      process.env[key] = input.env[key];
    }
    let output = '';
    try {
      const code = await policy.main(['--project-dir', input.project,
        '--baseline-dir', input.baseline], {
        write: text => { output += text; },
        collect: () => {
          fs.appendFileSync(path.join(input.project, 'package.json'), ' ');
          return {reports: [], snapshot: {id: 'unused'}};
        },
      });
      assert.equal(code, 2);
      assert(output.includes('review_manifest_sha256 mismatch'));
      temps.push(output.match(/Evidence: (.+)/)[1]);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) { delete process.env[key]; } else {
          process.env[key] = value;
        }
      }
    }
  });
});
