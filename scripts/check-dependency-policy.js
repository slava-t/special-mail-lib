/* eslint camelcase: ["error", {properties: "never"}] */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const zlib = require('zlib');
const {spawn} = require('child_process');
const {createRequire} = require('module');
const {TextDecoder} = require('util');
const YAML = require('yaml');

const REGISTRY = 'https://registry.npmjs.org';
const BULK = '/-/npm/v1/security/advisories/bulk';
const COOLDOWN = 336 * 60 * 60 * 1000;
const LIMIT = 64 * 1024 * 1024;
const TIMEOUT = 120000;
const SEVERITIES = ['info', 'low', 'moderate', 'high', 'critical'];
const FIELDS = ['dependencies', 'devDependencies',
  'optionalDependencies', 'peerDependencies'];
const object = value => value !== null && typeof value === 'object' &&
  !Array.isArray(value);
const check = (condition, message) => {
  if (!condition) { throw new Error(message); }
};
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const sorted = values => [...values].sort();
const canonical = value => JSON.stringify(value);
const sameSet = (a, b) => canonical(sorted(a)) === canonical(sorted(b));
const nameValid = name => typeof name === 'string' &&
  /^(?:@[a-z0-9_~][a-z0-9._~-]*\/)?[a-z0-9_~][a-z0-9._~-]*$/i.test(name) &&
  name !== 'node_modules';
const json = (bytes, label) => {
  try {
    return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
  } catch { throw new Error('Invalid JSON/UTF-8: ' + label); }
};
let npmTools;
const toolchain = () => {
  if (!npmTools) {
    const executable = path.join(path.dirname(process.execPath), 'npm');
    const cli = fs.realpathSync(executable);
    const root = path.resolve(path.dirname(cli), '..');
    const pkg = json(fs.readFileSync(path.join(root, 'package.json')), 'npm');
    check(pkg.name === 'npm' && pkg.version === '11.6.2',
      'Dependency policy requires installed npm 11.6.2 beside Node');
    check(path.basename(cli) === 'npm-cli.js', 'Unexpected npm executable');
    const semver = createRequire(path.join(root, 'package.json'))('semver');
    npmTools = {cli, semver, version: pkg.version};
  }
  return npmTools;
};
const exactVersion = value => typeof value === 'string' &&
  /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/
      .test(value) && Boolean(toolchain().semver.valid(value));
const pairKey = entry => canonical([entry.package, entry.version]);
const instanceKey = entry => canonical([
  entry.package, entry.version, entry.severity, entry.chain,
]);
const declaredKey = entry =>
  canonical([entry.id, entry.package, entry.severity]);
const regular = file => {
  check(fs.lstatSync(file).isFile(), 'Expected regular file: ' + file);
  return fs.readFileSync(file);
};
const readPair = directory => ({
  manifest: regular(path.join(directory, 'package.json')),
  lockfile: regular(path.join(directory, 'package-lock.json')),
});

const validateBaseline = (projectDir, baselineDir, env) => {
  for (const dir of [projectDir, baselineDir]) {
    check(fs.lstatSync(dir).isDirectory(), 'Expected directory: ' + dir);
  }
  check(fs.realpathSync(projectDir) !== fs.realpathSync(baselineDir),
    'Baseline and proposed directories must be disjoint');
  check(sameSet(fs.readdirSync(baselineDir),
    ['record.json', 'package.json', 'package-lock.json']),
  'Incomplete baseline inputs');
  const before = readPair(baselineDir);
  const after = readPair(projectDir);
  for (const name of ['package.json', 'package-lock.json']) {
    const a = fs.statSync(path.join(projectDir, name));
    const b = fs.statSync(path.join(baselineDir, name));
    check(a.dev !== b.dev || a.ino !== b.ino, 'Overlapping input files');
  }
  const record = json(regular(path.join(baselineDir, 'record.json')), 'record');
  const refs = ['target_commit', 'review_commit', 'baseline_ref',
    'baseline_commit', 'manifest_ref', 'lockfile_ref'];
  const hashes = ['manifest_sha256', 'lockfile_sha256',
    'review_manifest_sha256', 'review_lockfile_sha256'];
  const fields = [...refs, ...hashes, 'schema_version', 'run_id',
    'target_ref', 'merge_base_verified', 'lockfile_version'];
  check(object(record) && sameSet(Object.keys(record), fields),
    'Invalid baseline record fields');
  check(record.schema_version === 1, 'Invalid baseline record schema');
  check(record.merge_base_verified === true, 'Merge-base was not verified');
  for (const key of refs) {
    check(typeof record[key] === 'string' &&
      /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(record[key]), 'Invalid ' + key);
  }
  for (const key of [...hashes, 'run_id']) {
    check(typeof record[key] === 'string' && /^[0-9a-f]{64}$/.test(record[key]),
      'Invalid ' + key);
  }
  for (const key of ['baseline_ref', 'manifest_ref', 'lockfile_ref']) {
    check(record[key] === record.baseline_commit, 'Mixed baseline refs');
  }
  const runId = env.SML_BASELINE_RUN_ID;
  const encoded = env.SML_BASELINE_TARGET_B64;
  check(typeof runId === 'string' && /^[0-9a-f]{64}$/.test(runId),
    'Missing or invalid invocation run ID');
  check(runId === record.run_id, 'Baseline freshness mismatch');
  check(typeof encoded === 'string' && encoded.length > 0 &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
        .test(encoded), 'Invalid invocation target encoding');
  const bytes = Buffer.from(encoded, 'base64');
  const target = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
  check(bytes.toString('base64') === encoded && target.length > 0 &&
    typeof record.target_ref === 'string' && target === record.target_ref &&
    Buffer.from(record.target_ref, 'utf8').equals(bytes),
  'Invocation target mismatch');
  const lock = json(before.lockfile, 'baseline lockfile');
  check(object(lock) && Number.isInteger(record.lockfile_version) &&
    lock.lockfileVersion === record.lockfile_version,
  'Baseline lockfile version mismatch');
  const values = [before.manifest, before.lockfile,
    after.manifest, after.lockfile];
  hashes.forEach((key, index) => {
    check(digest(values[index]) === record[key], key + ' mismatch');
  });
  return {before, after, record};
};

const dependencies = (node, root) => {
  const result = new Map();
  for (const field of FIELDS) {
    if (field === 'devDependencies' && !root) { continue; }
    const entries = node[field];
    if (entries === undefined) { continue; }
    check(object(entries), 'Invalid dependency map: ' + field);
    for (const [name, spec] of Object.entries(entries)) {
      check(nameValid(name) && typeof spec === 'string' &&
        toolchain().semver.validRange(spec) !== null,
      'Unsupported dependency declaration: ' + name);
      // Optional declarations replace regular declarations, as npm does.
      if (field !== 'peerDependencies' || !result.has(name)) {
        result.set(name, spec);
      }
    }
  }
  return result;
};
const stateFromPair = pair => {
  const manifest = json(pair.manifest, 'manifest');
  const lock = json(pair.lockfile, 'lockfile');
  check(object(manifest) && object(lock), 'Pair must contain objects');
  check([2, 3].includes(lock.lockfileVersion), 'Unsupported lockfileVersion');
  check(object(lock.packages) && object(lock.packages['']),
    'Missing lockfile packages/root');
  const root = lock.packages[''];
  for (const field of FIELDS) {
    check(object(manifest[field] === undefined ? {} : manifest[field]) &&
      object(root[field] === undefined ? {} : root[field]),
    'Invalid root dependency map');
    const left = Object.entries(manifest[field] || {}).map(canonical);
    const right = Object.entries(root[field] || {}).map(canonical);
    check(sameSet(left, right), 'Manifest/root mismatch: ' + field);
  }
  const nodes = new Map();
  for (const [location, entry] of Object.entries(lock.packages)) {
    check(object(entry), 'Invalid lock entry: ' + location);
    check(!entry.link && !entry.inBundle && !entry.bundled &&
      !entry.bundleDependencies && !entry.bundledDependencies &&
      !entry.workspaces, 'Unsupported lock entry: ' + location);
    let name = manifest.name;
    if (location) {
      const parts = location.split('node_modules/');
      check(parts.shift() === '' && parts.length > 0,
        'Unsupported installed location: ' + location);
      const names = parts.map((part, index) =>
        index === parts.length - 1 ? part : part.slice(0, -1));
      check(names.every(nameValid) &&
        names.map(part => 'node_modules/' + part).join('/') === location,
      'Invalid installed location: ' + location);
      name = names[names.length - 1];
      check(entry.name === undefined || entry.name === name,
        'Unsupported alias entry: ' + location);
      check(exactVersion(entry.version), 'Invalid installed version: ' + name);
      if (entry.resolved !== undefined) {
        const url = new URL(entry.resolved);
        check(url.origin === REGISTRY && !url.username && !url.password &&
          url.pathname.endsWith('.tgz'), 'Unsupported registry entry: ' + name);
      }
    }
    nodes.set(location, {package: name, version: entry.version, location,
      declarations: dependencies(entry, location === ''), edges: []});
  }
  const resolve = (location, name) => {
    let dir = location;
    while (true) {
      if (path.posix.basename(dir) !== 'node_modules') {
        const candidate = (dir ? dir + '/' : '') + 'node_modules/' + name;
        if (nodes.has(candidate)) { return candidate; }
      }
      if (!dir) { return null; }
      const parent = path.posix.dirname(dir);
      dir = parent === '.' ? '' : parent;
    }
  };
  for (const node of nodes.values()) {
    node.edges = [...node.declarations.keys()]
        .map(name => resolve(node.location, name))
        .filter(value => value !== null);
  }
  const reached = new Set();
  const stack = [''];
  while (stack.length) {
    const location = stack.pop();
    if (reached.has(location)) { continue; }
    reached.add(location);
    stack.push(...nodes.get(location).edges);
  }
  check(reached.size === nodes.size, 'Unreachable installed lock entries: ' +
    [...nodes.keys()].filter(key => !reached.has(key)).join(', '));
  const pairs = new Map();
  const inventory = Object.create(null);
  for (const node of nodes.values()) {
    if (!node.location) { continue; }
    pairs.set(pairKey(node), {package: node.package, version: node.version});
    (inventory[node.package] ||= new Set()).add(node.version);
  }
  const payload = Object.fromEntries(Object.keys(inventory).sort()
      .map(name => [name, sorted(inventory[name])]));
  return {pair, nodes, pairs, payload};
};
const walk = (state, visit) => {
  const queue = state.nodes.get('').edges.map(location => ({
    location, chain: [], seen: new Set(),
  }));
  while (queue.length) {
    const {location, chain, seen} = queue.pop();
    if (seen.has(location)) { continue; }
    const node = state.nodes.get(location);
    const names = [...chain, node.package];
    visit(node, names);
    const next = new Set(seen).add(location);
    for (const child of node.edges) {
      queue.push({location: child, chain: names, seen: next});
    }
  }
};
const advisoryValid = advisory => object(advisory) &&
  nameValid(advisory.name) && advisory.dependency === advisory.name &&
  (Number.isInteger(advisory.source) ||
    (typeof advisory.source === 'string' && advisory.source.length > 0)) &&
  SEVERITIES.includes(advisory.severity) &&
  (advisory.url === null || (typeof advisory.url === 'string' &&
    advisory.url.startsWith('https://'))) &&
  typeof advisory.range === 'string' &&
  toolchain().semver.validRange(advisory.range, {loose: true}) !== null;
const validateReport = (report, state) => {
  check(object(report) && !report.error && report.auditReportVersion === 2 &&
    object(report.vulnerabilities) && object(report.metadata) &&
    object(report.metadata.dependencies) &&
    object(report.metadata.vulnerabilities), 'Invalid npm audit report');
  const counts = report.metadata;
  check([...SEVERITIES, 'total'].every(key =>
    Number.isInteger(counts.vulnerabilities[key])) &&
    ['prod', 'dev', 'optional', 'peer', 'peerOptional', 'total'].every(key =>
      Number.isInteger(counts.dependencies[key])), 'Incomplete audit metadata');
  check(counts.vulnerabilities.total ===
    Object.keys(report.vulnerabilities).length, 'Audit vulnerability count');
  check(counts.dependencies.total === state.nodes.size - 1,
    'Audit inventory count mismatch');
  for (const type of ['dependencies', 'vulnerabilities']) {
    check(Object.values(counts[type]).every(value =>
      Number.isInteger(value) && value >= 0), 'Invalid audit metadata counts');
  }
  for (const [name, entry] of Object.entries(report.vulnerabilities)) {
    check(nameValid(name) && object(entry) && entry.name === name &&
      Object.hasOwn(state.payload, name) &&
      SEVERITIES.includes(entry.severity) &&
      typeof entry.isDirect === 'boolean' &&
      typeof entry.range === 'string' && Array.isArray(entry.via) &&
      Array.isArray(entry.nodes) && Array.isArray(entry.effects) &&
      entry.effects.every(value => typeof value === 'string') &&
      entry.nodes.every(location => state.nodes.has(location) &&
        state.nodes.get(location).package === name) &&
      (typeof entry.fixAvailable === 'boolean' || object(entry.fixAvailable)),
    'Invalid audit vulnerability: ' + name);
    for (const via of entry.via) {
      check(typeof via === 'string' ? nameValid(via) :
        advisoryValid(via) && via.name === name, 'Invalid advisory: ' + name);
    }
  }
  return report;
};
const instances = (state, report) => {
  validateReport(report, state);
  const entries = new Map();
  walk(state, (node, chain) => {
    const via = report.vulnerabilities[node.package]?.via || [];
    for (const advisory of via) {
      if (!object(advisory) || !toolchain().semver.satisfies(
        node.version, advisory.range, {includePrerelease: true, loose: true}
      )) {
        continue;
      }
      const instance = {package: node.package, version: node.version,
        severity: advisory.severity, chain};
      const key = instanceKey(instance);
      if (!entries.has(key)) {
        entries.set(key, {...instance, advisories: []});
      }
      const evidence = {id: String(advisory.source), url: advisory.url};
      const ids = entries.get(key).advisories;
      if (!ids.some(item => item.id === evidence.id)) { ids.push(evidence); }
    }
  });
  return entries;
};

const request = (url, {method = 'GET', body} = {}) => new Promise(
  (resolve, reject) => {
    const req = https.request(url, {method, headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      'user-agent': 'special-mail-lib-dependency-policy',
    }}, response => {
      const chunks = [];
      let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > LIMIT) {
          req.destroy(new Error('Registry response too large'));
        } else { chunks.push(chunk); }
      });
      response.on('error', reject);
      response.on('end', () => {
        clearTimeout(timer);
        if (response.statusCode !== 200) {
          reject(new Error(
            'Registry HTTP ' + response.statusCode + ': ' + url
          ));
        } else { resolve(Buffer.concat(chunks)); }
      });
    });
    const timer = setTimeout(() => req.destroy(new Error('Registry timeout')),
      TIMEOUT);
    req.on('error', error => { clearTimeout(timer); reject(error); });
    req.end(body);
  }
);
const cleanEnv = env => Object.fromEntries(Object.entries(env).filter(([key]) =>
  !/^(?:npm_config_|node_|ld_|dyld_)/i.test(key)));
const runAudit = ({directory, registry, cache, userconfig, globalconfig}) =>
  new Promise((resolve, reject) => {
    const args = [toolchain().cli, 'audit', '--package-lock-only',
      '--include=dev', '--include=optional', '--include=peer', '--json',
      '--registry=' + registry, '--audit-registry=' + registry,
      '--offline=false', '--audit=true', '--ignore-scripts=true',
      '--update-notifier=false',
      '--prefer-online=true', '--fetch-retries=0',
      '--fetch-timeout=' + TIMEOUT, '--cache=' + cache,
      '--userconfig=' + userconfig, '--globalconfig=' + globalconfig];
    const child = spawn(process.execPath, args, {
      cwd: directory, env: cleanEnv(process.env),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    let size = 0;
    let failure;
    const fail = message => {
      failure ||= new Error(message);
      child.kill('SIGKILL');
    };
    const timer = setTimeout(() => fail('npm audit timeout'), TIMEOUT * 2);
    for (const [stream, chunks] of [[child.stdout, stdout],
      [child.stderr, stderr]]) {
      stream.on('data', chunk => {
        size += chunk.length;
        if (size > LIMIT) { fail('npm audit output too large'); } else {
          chunks.push(chunk);
        }
      });
    }
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (failure) { reject(failure); } else {
        resolve({code, stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr), args});
      }
    });
  });
const payloadKey = payload => {
  check(object(payload), 'Invalid audit inventory payload');
  return canonical(Object.keys(payload).sort().map(name => {
    check(nameValid(name) && Array.isArray(payload[name]) &&
      payload[name].every(exactVersion) &&
      new Set(payload[name]).size === payload[name].length,
    'Invalid audit inventory versions: ' + name);
    return [name, sorted(payload[name])];
  }));
};
const validateBulk = (bytes, union) => {
  const data = json(bytes, 'bulk advisory snapshot');
  check(object(data), 'Invalid bulk advisory snapshot');
  for (const [name, advisories] of Object.entries(data)) {
    check(Object.hasOwn(union, name) && Array.isArray(advisories),
      'Unexpected bulk advisory package');
    for (const entry of advisories) {
      check(object(entry) &&
        (entry.name === undefined || entry.name === name) &&
        Number.isInteger(entry.id) && typeof entry.url === 'string' &&
        entry.url.startsWith('https://') && SEVERITIES.includes(entry.severity) &&
        typeof entry.vulnerable_versions === 'string' &&
        toolchain().semver.validRange(entry.vulnerable_versions,
          {loose: true}) !== null, 'Invalid bulk advisory: ' + name);
    }
  }
  return data;
};
const collect = async (before, after, evidenceDir, hooks = {}) => {
  // Injection is available only through this imported function, never CLI/env.
  const fetch = hooks.fetch || request;
  const audit = hooks.audit || runAudit;
  const union = Object.create(null);
  for (const state of [before, after]) {
    for (const [name, versions] of Object.entries(state.payload)) {
      union[name] = sorted(new Set([...(union[name] || []), ...versions]));
    }
  }
  const payload = Buffer.from(canonical(Object.fromEntries(
    Object.keys(union).sort().map(name => [name, union[name]])
  )));
  const started = new Date().toISOString();
  const bulkBytes = await fetch(REGISTRY + BULK,
    {method: 'POST', body: payload});
  const bulk = validateBulk(bulkBytes, union);
  fs.writeFileSync(path.join(evidenceDir, 'bulk-request.json'), payload);
  fs.writeFileSync(path.join(evidenceDir, 'bulk-response.json'), bulkBytes);
  const metadata = new Map();
  const failures = [];
  const packuments = Object.create(null);
  const getPackument = name => {
    if (!metadata.has(name)) {
      const pending = (async () => {
        const url = REGISTRY + '/' + encodeURIComponent(name);
        const bytes = await fetch(url);
        const value = json(bytes, 'packument ' + name);
        check(object(value) && value.name === name && object(value.versions),
          'Invalid packument: ' + name);
        const hash = digest(bytes);
        fs.writeFileSync(path.join(evidenceDir, 'packument-' + hash + '.json'),
          bytes);
        packuments[name] = {url, sha256: hash,
          collected_at: new Date().toISOString()};
        return {bytes, value};
      })();
      metadata.set(name, pending);
    }
    return metadata.get(name);
  };
  let active;
  let requests = 0;
  const server = http.createServer(async (req, res) => {
    try {
      check(active, 'Registry request outside an active audit');
      const url = new URL(req.url, 'http://127.0.0.1');
      check(!url.search, 'Unexpected registry query');
      if (req.method === 'POST' && url.pathname === BULK) {
        const chunks = [];
        let length = 0;
        for await (const chunk of req) {
          length += chunk.length;
          check(length <= LIMIT, 'Audit inventory request too large');
          chunks.push(chunk);
        }
        const compressed = Buffer.concat(chunks);
        const encoding = req.headers['content-encoding'];
        check(!encoding || encoding === 'gzip', 'Invalid encoding');
        const bytes = encoding === 'gzip' ? zlib.gunzipSync(compressed,
          {maxOutputLength: LIMIT}) : compressed;
        const inventory = json(bytes, 'npm audit inventory');
        check(payloadKey(inventory) === payloadKey(active.payload),
          'Audit inventory payload mismatch');
        requests++;
        check(requests === 1, 'Repeated audit bulk request');
        const filtered = Object.fromEntries(Object.keys(inventory)
            .filter(name => Object.hasOwn(bulk, name))
            .map(name => [name, bulk[name]]));
        res.writeHead(200, {'content-type': 'application/json'});
        res.end(canonical(filtered));
      } else {
        const name = decodeURIComponent(url.pathname.slice(1));
        check(req.method === 'GET' && nameValid(name) &&
          Object.hasOwn(union, name),
        'Unexpected registry endpoint: ' + req.method + ' ' + url.pathname);
        const captured = await getPackument(name);
        res.writeHead(200, {'content-type': 'application/json'});
        res.end(captured.bytes);
      }
    } catch (error) {
      failures.push(error.message);
      if (!res.headersSent) { res.writeHead(502); }
      res.end('Dependency policy registry input failed');
    }
  });
  server.requestTimeout = TIMEOUT;
  let temporary;
  const reports = [];
  const auditRuns = [];
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const registry = 'http://127.0.0.1:' + server.address().port;
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'sml-policy-audits-'));
    for (const [index, state] of [before, after].entries()) {
      const directory = path.join(temporary, String(index));
      fs.mkdirSync(directory);
      const userconfig = path.join(temporary, index + '-user.npmrc');
      const globalconfig = path.join(temporary, index + '-global.npmrc');
      fs.writeFileSync(userconfig, '');
      fs.writeFileSync(globalconfig, '');
      fs.writeFileSync(path.join(directory, 'package.json'),
        state.pair.manifest);
      fs.writeFileSync(path.join(directory, 'package-lock.json'),
        state.pair.lockfile);
      active = state;
      requests = 0;
      const result = await audit({directory, registry, userconfig, globalconfig,
        cache: path.join(temporary, index + '-cache')});
      active = null;
      fs.writeFileSync(path.join(evidenceDir, index + '-audit.json'),
        result.stdout);
      fs.writeFileSync(path.join(evidenceDir, index + '-audit.stderr'),
        result.stderr);
      auditRuns.push({exit_code: result.code, args: result.args,
        stdout_sha256: digest(result.stdout)});
      check(failures.length === 0,
        'Registry adapter failure: ' + failures.join('; '));
      check(requests === (state.pairs.size ? 1 : 0), 'Missing bulk request');
      check(result.code === 0 || result.code === 1, 'npm audit failed');
      const current = readPair(directory);
      check(current.manifest.equals(state.pair.manifest) &&
        current.lockfile.equals(state.pair.lockfile), 'Audit changed inputs');
      reports.push(validateReport(
        json(result.stdout, 'npm audit stdout'), state
      ));
    }
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    if (temporary) { fs.rmSync(temporary, {recursive: true, force: true}); }
  }
  const snapshot = {
    npm_version: toolchain().version, started_at: started,
    completed_at: new Date().toISOString(), source: REGISTRY + BULK,
    union_sha256: digest(payload), bulk_sha256: digest(bulkBytes),
    packuments: {...packuments}, audits: auditRuns,
  };
  const index = Object.keys(packuments).sort()
      .map(name => [name, packuments[name].sha256]);
  snapshot.packument_index_sha256 = digest(canonical(index));
  snapshot.id = digest(canonical([snapshot.union_sha256,
    snapshot.bulk_sha256, snapshot.packument_index_sha256]));
  fs.writeFileSync(path.join(evidenceDir, 'snapshot.json'),
    JSON.stringify(snapshot, null, 2) + '\n');
  return {reports, snapshot, publish: async name => {
    const captured = await getPackument(name);
    fs.writeFileSync(path.join(evidenceDir, 'publish-index.json'),
      JSON.stringify(packuments, null, 2) + '\n');
    return captured.value;
  }};
};

const readLedger = bytes => {
  const doc = YAML.parseDocument(bytes.toString('utf8'), {uniqueKeys: true});
  check(doc.errors.length === 0, 'Invalid policy YAML');
  const ledger = doc.toJS({maxAliasCount: 100});
  check(object(ledger) && ledger.schema_version === 1 &&
    Object.hasOwn(ledger, 'upgrade_record') && Object.hasOwn(ledger, 'waivers'),
  'Invalid policy ledger schema');
  check(ledger.upgrade_record === null || object(ledger.upgrade_record),
    'Invalid upgrade record');
  const advisories = ledger.upgrade_record?.advisories;
  check(advisories === undefined || Array.isArray(advisories),
    'Invalid declared advisory list');
  const declarations = new Map();
  for (const entry of advisories || []) {
    check(object(entry) &&
      typeof entry.id === 'string' && entry.id.length > 0 &&
      nameValid(entry.package) && SEVERITIES.includes(entry.severity),
    'Invalid declared advisory');
    const value = {id: entry.id, package: entry.package,
      severity: entry.severity};
    declarations.set(declaredKey(value), value);
  }
  return {ledger, declared: [...declarations.values()]};
};
const driverKeys = drivers => [
  ...drivers.derived.map(entry => 'instance:' + instanceKey(entry)),
  ...drivers.declared.map(entry => 'declared:' + declaredKey(entry)),
];
const waiverDrivers = value => {
  check(object(value) && Array.isArray(value.derived) &&
    Array.isArray(value.declared), 'Invalid waiver drivers');
  for (const entry of value.derived) {
    check(object(entry) && nameValid(entry.package) &&
      exactVersion(entry.version) &&
      ['high', 'critical'].includes(entry.severity) &&
      Array.isArray(entry.chain) && entry.chain.length > 0 &&
      entry.chain.every(nameValid) &&
      entry.chain[entry.chain.length - 1] === entry.package,
    'Invalid waiver instance');
  }
  for (const entry of value.declared) {
    check(object(entry) &&
      typeof entry.id === 'string' && entry.id.length > 0 &&
      nameValid(entry.package) && SEVERITIES.includes(entry.severity),
    'Invalid waiver declaration');
  }
  return driverKeys(value);
};
const utcTime = value => {
  check(typeof value === 'string' &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value),
  'Missing or invalid UTC timestamp');
  const time = Date.parse(value);
  check(Number.isFinite(time) &&
    new Date(time).toISOString().slice(0, 19) === value.slice(0, 19),
  'Invalid UTC calendar time');
  return time;
};
const transitionValid = (value, before, after) => object(value) &&
  nameValid(value.package) && exactVersion(value.from_version) &&
  exactVersion(value.target_version) &&
  toolchain().semver.gt(value.target_version, value.from_version) &&
  before.pairs.has(pairKey({package: value.package,
    version: value.from_version})) &&
  after.pairs.has(pairKey({package: value.package,
    version: value.target_version}));
const hasUpgrade = (before, after, record) => {
  if (Array.isArray(record?.upgrades) && record.upgrades.some(value =>
    transitionValid(value, before, after))) { return true; }
  for (const [key, entry] of after.pairs) {
    if (before.pairs.has(key)) { continue; }
    if ([...before.pairs.values()].some(previous =>
      previous.package === entry.package &&
      toolchain().semver.gt(entry.version, previous.version))) { return true; }
  }
  // Same-name versions can already exist elsewhere: compare common chains too.
  const chains = new Map();
  walk(before, (node, chain) => {
    const key = canonical(chain);
    if (!chains.has(key)) { chains.set(key, new Set()); }
    chains.get(key).add(node.version);
  });
  let increase = false;
  walk(after, (node, chain) => {
    if ([...(chains.get(canonical(chain)) || [])].some(version =>
      toolchain().semver.gt(node.version, version))) { increase = true; }
  });
  return increase;
};
const applicableWaivers = (ledger, drivers, before, after, now) => {
  check(Array.isArray(ledger.waivers), 'Invalid waiver list');
  const ids = new Set();
  const admitted = new Map();
  const rejected = [];
  const record = ledger.upgrade_record;
  const refs = record?.waiver_refs;
  check(refs === undefined || (Array.isArray(refs) &&
    refs.every(value => typeof value === 'string')), 'Invalid waiver refs');
  const effective = driverKeys(drivers);
  for (const waiver of ledger.waivers) {
    check(object(waiver) &&
      typeof waiver.id === 'string' && waiver.id.length > 0,
    'Invalid waiver ID');
    check(!ids.has(waiver.id), 'Duplicate waiver ID');
    ids.add(waiver.id);
    try {
      check((refs || []).includes(waiver.id), 'Waiver is not referenced');
      check(typeof waiver.user_statement === 'string' &&
        waiver.user_statement.trim().length > 0, 'Missing user statement');
      check(utcTime(waiver.date) <= now, 'Future waiver authorization');
      check(Array.isArray(waiver.admitted_entries) &&
        waiver.admitted_entries.every(entry => object(entry) &&
          nameValid(entry.package) && exactVersion(entry.version)),
      'Invalid exact admitted entries');
      const named = waiverDrivers(waiver.drivers);
      check(named.length > 0 && named.every(key => effective.includes(key)),
        'Waiver drivers do not match effective evidence');
      const scope = waiver.scope;
      check(object(scope), 'Missing waiver scope');
      if (scope.kind === 'upgrade') {
        check(transitionValid(scope, before, after), 'Unmatched upgrade scope');
        check(Array.isArray(record?.upgrades) && record.upgrades.some(value =>
          transitionValid(value, before, after) &&
          value.package === scope.package &&
          value.from_version === scope.from_version &&
          value.target_version === scope.target_version),
        'Upgrade scope is not recorded');
      } else {
        check(scope.kind === 'change-set' && sameSet(named, effective),
          'Unmatched change-set drivers');
        check(!hasUpgrade(before, after, record),
          'Change-set waiver cannot cover an expressible upgrade');
      }
      for (const entry of waiver.admitted_entries) {
        admitted.set(pairKey(entry), waiver.id);
      }
    } catch (error) { rejected.push({id: waiver.id, reason: error.message}); }
  }
  return {admitted, rejected};
};
const evaluate = async (before, after, reports, policy, publish, now) => {
  check(Number.isFinite(now), 'Invalid gate-run time');
  const pre = instances(before, reports[0]);
  const post = instances(after, reports[1]);
  const derived = [...pre.entries()].filter(([key, value]) =>
    ['high', 'critical'].includes(value.severity) && !post.has(key))
      .map(([, value]) => value);
  const drivers = {derived, declared: policy.declared};
  const result = {check_time: new Date(now).toISOString(),
    outcome: 'unpoliced', exit_code: 0, drivers,
    counts: {before_entries: before.nodes.size - 1,
      after_entries: after.nodes.size - 1,
      before_instances: pre.size, after_instances: post.size},
    newly_introduced: [], entries: [], errors: [], rejected_waivers: []};
  if (!derived.length && !policy.declared.length) { return result; }
  result.outcome = 'compliant';
  const added = [...after.pairs.entries()]
      .filter(([key]) => !before.pairs.has(key)).map(([, entry]) => entry);
  result.newly_introduced = added;
  const waivers = applicableWaivers(policy.ledger, drivers, before, after, now);
  result.rejected_waivers = waivers.rejected;
  const captured = new Map();
  for (const entry of added) {
    try {
      if (!captured.has(entry.package)) {
        captured.set(entry.package, Promise.resolve().then(() =>
          publish(entry.package)));
      }
      const packument = await captured.get(entry.package);
      check(object(packument) && object(packument.time),
        'Missing publish metadata: ' + entry.package);
      const timestamp = packument.time[entry.version];
      const published = utcTime(timestamp);
      check(published <= now, 'Publish time is in the future');
      const age = now - published;
      const waiver = waivers.admitted.get(pairKey(entry));
      const violation = age < COOLDOWN && !waiver;
      result.entries.push({...entry, published_at: timestamp,
        age_hours: age / 3600000,
        adoptable_from: new Date(published + COOLDOWN).toISOString(),
        waiver_id: waiver || null,
        status: violation ? 'violation' :
          age < COOLDOWN ? 'waived' : 'old-enough',
        reason: violation ? 'No applicable waiver for exact pair' :
          null});
    } catch (error) { result.errors.push({...entry, error: error.message}); }
  }
  if (result.errors.length) {
    result.exit_code = 2;
    result.outcome = 'inconclusive';
  } else if (result.entries.some(entry => entry.status === 'violation')) {
    result.exit_code = 1;
    result.outcome = 'cooldown-violation';
  }
  return result;
};

const options = args => {
  const result = {projectDir: path.resolve(__dirname, '..')};
  const used = new Set();
  for (let i = 0; i < args.length; i += 2) {
    const option = args[i];
    check(['--project-dir', '--baseline-dir'].includes(option) &&
      !used.has(option) && args[i + 1] && !args[i + 1].startsWith('--'),
    'Usage: check-dependency-policy.js ' +
      '[--project-dir path] [--baseline-dir path]');
    used.add(option);
    result[option === '--project-dir' ? 'projectDir' : 'baselineDir'] =
      path.resolve(args[i + 1]);
  }
  result.baselineDir ||= path.join(result.projectDir, '.ci2-baseline');
  return result;
};
const main = async (args, hooks = {}) => {
  let evidenceDir;
  let result;
  try {
    const {projectDir, baselineDir} = options(args);
    const inputs = validateBaseline(projectDir, baselineDir, process.env);
    const before = stateFromPair(inputs.before);
    const after = stateFromPair(inputs.after);
    const policy = readLedger(regular(path.join(projectDir,
      'ci2/policy/dependency-policy.yaml')));
    const now = Date.now();
    evidenceDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'sml-policy-evidence-')
    );
    const collected = await (hooks.collect || collect)(
      before, after, evidenceDir
    );
    const repeated = validateBaseline(projectDir, baselineDir, process.env);
    check(canonical(repeated.record) === canonical(inputs.record),
      'Baseline record changed during collection');
    for (const side of ['before', 'after']) {
      for (const field of ['manifest', 'lockfile']) {
        check(inputs[side][field].equals(repeated[side][field]),
          'Dependency inputs changed during collection');
      }
    }
    result = await evaluate(before, after, collected.reports, policy,
      collected.publish, now);
    result.baseline = inputs.record;
    result.snapshot = collected.snapshot;
  } catch (error) {
    result = {outcome: 'inconclusive', exit_code: 2, errors: [error.message]};
  }
  if (evidenceDir) {
    result.evidence_directory = evidenceDir;
    fs.writeFileSync(path.join(evidenceDir, 'result.json'),
      JSON.stringify(result, null, 2) + '\n');
  }
  const write = hooks.write || (text => process.stdout.write(text));
  write('Dependency policy: ' + result.outcome + '\n');
  for (const driver of result.drivers?.derived || []) {
    write('Removed instance: ' + instanceKey(driver) + '\n');
  }
  for (const driver of result.drivers?.declared || []) {
    write('Declared driver: ' + declaredKey(driver) + '\n');
  }
  for (const entry of result.entries || []) {
    if (entry.status !== 'violation') { continue; }
    write('Cooldown violation: ' + entry.package + '@' + entry.version +
      '; published ' + entry.published_at + '; age ' + entry.age_hours +
      ' hours; adoptable from ' + entry.adoptable_from + '; ' + entry.reason +
      '\n');
  }
  for (const waiver of result.rejected_waivers || []) {
    write('Unmatched waiver ' + waiver.id + ': ' + waiver.reason + '\n');
  }
  for (const error of result.errors) {
    write('Input error: ' + (typeof error === 'string' ? error :
      canonical(error)) + '\n');
  }
  if (result.snapshot) {
    write('Advisory snapshot: ' + result.snapshot.id + '\n');
  }
  if (evidenceDir) { write('Evidence: ' + evidenceDir + '\n'); }
  return result.exit_code;
};

module.exports = {validateBaseline, stateFromPair, walk, instances, readLedger,
  evaluate, collect, main, runAudit, cleanEnv};
if (require.main === module) {
  main(process.argv.slice(2)).then(code => {
    process.exitCode = code;
  }, error => {
    process.stderr.write(
      'Dependency policy input error: ' + error.message + '\n'
    );
    process.exitCode = 2;
  });
}
