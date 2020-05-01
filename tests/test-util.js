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

