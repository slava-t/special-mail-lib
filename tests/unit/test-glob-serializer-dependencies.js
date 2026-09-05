const assert = require('assert').strict;
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const vm = require('vm');
const {createRequire} = require('module');
const eslintRequire = createRequire(require.resolve('eslint'));
const mochaRequire = createRequire(require.resolve('mocha'));
const globRequire = createRequire(mochaRequire.resolve('glob'));
const lookupFiles = mochaRequire('./lib/cli/lookup-files');
const {BufferedWorkerPool} = mochaRequire('./lib/nodejs/buffered-worker-pool');
const anymatch = require('anymatch');
const micromatch = require('micromatch');

describe('glob and serializer dependency compatibility', function() {
  this.timeout(5000);
  let directory;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sml-glob-deps-'));
    BufferedWorkerPool.resetOptionsCache();
  });

  afterEach(async () => {
    BufferedWorkerPool.resetOptionsCache();
    await fs.rm(directory, {recursive: true, force: true});
  });

  it('discovers Mocha files through globstar and brace patterns', async () => {
    const files = [
      'test-top.js', 'nested/test-child.cjs', 'nested/helper.js',
      '.hidden/test-secret.js', 'nested/test-types.ts'
    ];
    for (const file of files) {
      const destination = path.join(directory, file);
      await fs.mkdir(path.dirname(destination), {recursive: true});
      await fs.writeFile(destination, '');
    }
    const pattern = path.join(directory, '**/test-*.{js,cjs}');
    assert.deepEqual(lookupFiles(pattern).sort(), [
      path.join(directory, 'test-top.js'),
      path.join(directory, 'nested/test-child.cjs')
    ].sort());
    assert.throws(() => lookupFiles(path.join(directory, '**/absent-*.js')),
      {code: 'ERR_MOCHA_NO_FILES_MATCH_PATTERN'});
  });

  it('preserves matching through the ESLint, Mocha and glob copies', () => {
    const cases = [
      ['tests/unit/test-a.js', 'tests/{unit,int}/test-*.js', true],
      ['tests/other/test-a.js', 'tests/{unit,int}/test-*.js', false],
      ['test-2.js', 'test-{1..3}.js', true],
      ['test-4.js', 'test-{1..3}.js', false],
      ['abbb.js', '+(a|+(b)).js', true],
      ['ac.js', '+(a|+(b)).js', false],
      ['ababa.js', 'a*b*a*.js', true],
      ['bbb.js', 'a*b*a*.js', false],
      ['tests/a/unit/b/test-a.js', 'tests/**/unit/**/test-*.js', true],
      ['tests/a/int/b/test-a.js', 'tests/**/unit/**/test-*.js', false],
      ['tests/.hidden/test-a.js', 'tests/**/test-*.js', false]
    ];
    for (const consumer of [eslintRequire, mochaRequire, globRequire]) {
      const minimatch = consumer('minimatch');
      for (const [file, pattern, expected] of cases) {
        assert.equal(minimatch(file, pattern), expected,
          `${consumer.resolve('minimatch')}: ${file} / ${pattern}`);
      }
    }
  });

  it('preserves picomatch behavior through anymatch and micromatch', () => {
    const pattern = 'tests/**/+(test|spec)-*.js';
    const cases = [
      ['tests/unit/test-a.js', true],
      ['tests/int/nested/spec-b.js', true],
      ['tests/unit/helper.js', false],
      ['tests/.hidden/test-a.js', false],
      ['tests/unit/test-a.ts', false]
    ];
    for (const [file, expected] of cases) {
      assert.equal(anymatch(pattern, file), expected, file);
      assert.equal(micromatch.isMatch(file, pattern), expected, file);
    }
  });

  it('round-trips ordinary Mocha worker options and omits functions', () => {
    const options = {
      grep: /test-(one|two)/gi,
      timeout: 1200,
      bail: true,
      spec: ['test-one.js', 'nested/test-two.js'],
      fixtureDate: new Date('2020-01-02T03:04:05.000Z'),
      fixtureCallback: () => 1
    };
    const serialized = BufferedWorkerPool.serializeOptions(options);
    const restored = vm.runInNewContext(`(${serialized})`,
      Object.create(null), {timeout: 1000});
    assert.equal(restored.grep.source, 'test-(one|two)');
    assert.equal(restored.grep.flags, 'gi');
    assert.equal(restored.timeout, 1200);
    assert.equal(restored.bail, true);
    assert.deepEqual(Array.from(restored.spec), options.spec);
    assert.equal(restored.fixtureDate.toISOString(),
      '2020-01-02T03:04:05.000Z');
    assert.equal(Object.hasOwn(restored, 'fixtureCallback'), false);
  });

  it('does not execute an expression injected through RegExp flags', () => {
    const grep = /fixture/;
    // The expression only changes a numeric marker in an isolated context.
    Object.defineProperty(grep, 'flags', {value: '"+(X=1,"")+"'});
    const serialized = BufferedWorkerPool.serializeOptions({grep});
    const context = vm.createContext(Object.create(null));
    context.X = 0;
    const restored = vm.runInContext(`(${serialized})`, context,
      {timeout: 1000});
    assert.equal(context.X, 0);
    assert.equal(restored.grep.source, 'fixture');
  });

  it('rejects an injected Date string before worker option evaluation', () => {
    const fixtureDate = new Date('2020-01-02T03:04:05.000Z');
    // Keep the method non-enumerable so ignoreFunction preserves the fixture.
    Object.defineProperty(fixtureDate, 'toISOString', {
      value: () => '"+(X=1)+"'
    });
    assert.throws(() => BufferedWorkerPool.serializeOptions({fixtureDate}),
      TypeError);
  });
});
