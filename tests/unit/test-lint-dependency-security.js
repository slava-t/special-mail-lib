const assert = require('assert').strict;
const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const {createRequire} = require('module');
const babelRequire = createRequire(require.resolve('@babel/core'));
const targetsRequire = createRequire(
  babelRequire.resolve('@babel/helper-compilation-targets')
);
const browserslist = targetsRequire('browserslist');
const eslintRequire = createRequire(require.resolve('eslint'));
const entryCacheRequire = createRequire(
  eslintRequire.resolve('file-entry-cache')
);
const flatCache = entryCacheRequire('flat-cache');
const {loadConfig} = require('mocha/lib/cli/config');

describe('lint dependency security and configuration', function() {
  this.timeout(5000);
  let directory;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sml-lint-deps-'));
    browserslist.clearCaches();
  });

  afterEach(async () => {
    browserslist.clearCaches();
    await fs.rm(directory, {recursive: true, force: true});
  });

  it('handles inherited-name keys in custom browser statistics', () => {
    const query = 'chrome 100';
    const ordinary = {chrome: {'100': 100}};
    assert.deepEqual(browserslist(query, {
      stats: ordinary, path: directory
    }), ['chrome 100']);

    const stats = JSON.parse(
      '{"constructor":{"0":1},"chrome":{"100":100}}'
    );
    assert.deepEqual(browserslist(query, {
      stats, path: directory
    }), ['chrome 100']);
  });

  it('persists cache values and shared references', () => {
    const file = path.join(directory, 'ordinary-cache');
    const cache = flatCache.createFromFile(file);
    const shared = {size: 42};
    cache.setKey('first', {name: 'fixture', shared});
    cache.setKey('second', shared);
    cache.save();

    const reopened = flatCache.createFromFile(file);
    const first = reopened.getKey('first');
    assert.deepEqual(first, {name: 'fixture', shared: {size: 42}});
    assert.equal(first.shared, reopened.getKey('second'));
  });

  it('does not expose a live prototype from an invalid cache reference',
    async () => {
      const file = path.join(directory, 'invalid-cache');
      await fs.writeFile(file, '[{"escaped":"__proto__"}]');
      const cache = flatCache.createFromFile(file);
      // Inspect the returned reference without writing through it.
      assert.notEqual(cache.getKey('escaped'), Array.prototype);
    });

  it('loads Mocha YAML options with lists and an anchor merge', async () => {
    const file = path.join(directory, 'options.yaml');
    await fs.writeFile(file, [
      'base: &base',
      '  timeout: 1000',
      '  color: false',
      '<<: *base',
      'spec:',
      '  - tests/unit/test-fixture.js',
      'reporter: dot',
      ''
    ].join('\n'));
    assert.deepEqual(loadConfig(file), {
      base: {timeout: 1000, color: false},
      timeout: 1000,
      color: false,
      spec: ['tests/unit/test-fixture.js'],
      reporter: 'dot'
    });
  });

  it('preserves YAML ordered pairs and rejects duplicate ordered-map keys',
    async () => {
      const file = path.join(directory, 'ordered.yaml');
      await fs.writeFile(file, [
        'reporter-option: !!omap',
        '  - alpha: first',
        '  - beta: second',
        ''
      ].join('\n'));
      assert.deepEqual(loadConfig(file), {
        'reporter-option': [{alpha: 'first'}, {beta: 'second'}]
      });

      await fs.writeFile(file, [
        'reporter-option: !!omap',
        '  - alpha: first',
        '  - alpha: second',
        ''
      ].join('\n'));
      assert.throws(() => loadConfig(file), /Unable to read\/parse/);
    });
});
