const assert = require('assert').strict;
const util = require('../util.js');

describe('normalizeEOLs', function() {
  it('should correctly normalize non strings', function() {
    assert.deepEqual([1, 'two'], util.normalizeEOLs([1, 'two']));
    assert.equal(5, util.normalizeEOLs(5));
  });

  it('should correctly normalize strings and keep CRs', function() {
    assert.equal('a\r\n b\r\n c\r\n', util.normalizeEOLs('a\r\n b\r c\n'));
    assert.equal('', util.normalizeEOLs(''));
    assert.equal('any', util.normalizeEOLs('any'));
    assert.equal('\r\nany\r\n', util.normalizeEOLs('\nany\n'));
    assert.equal('\r\nany\r\n', util.normalizeEOLs('\rany\r'));
    assert.equal('\r\nany\r\n', util.normalizeEOLs('\r\nany\r\n'));
    assert.equal('\r\n\r\nany\r\n\r\n', util.normalizeEOLs('\n\rany\n\r'));
  });

  it('should correctly normalize strings and remove CRs', function() {
    assert.equal('a\r\n b c\r\n', util.normalizeEOLs('a\r\n b\r c\n', false));
    assert.equal('any', util.normalizeEOLs('\rany\r', false));
    assert.equal('\r\nany\r\n', util.normalizeEOLs('\n\rany\n\r', false));
  });

});

describe('generateMessageId', function() {
  it(
    'should correctly generate a message derived from a domain and a prefix',
    function() {
      const id = util.generateMessageId('domain.com', 'test.');
      let parts = id.split('.');
      assert.equal('<test', parts[0]);
      assert(/^[0-9]+$/.test(parts[1]));
      assert.equal(parts[3], 'com>');
      parts = parts[2].split('@');

      assert(/[0-9a-f]{24}/.test(parts[0]));
      assert.equal('domain', parts[1]);
    }
  );
});
