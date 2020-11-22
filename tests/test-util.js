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

describe('randomAlphanumeric', function() {
  it(
    'should coorrectly generate a  stringof lenggh 0',
    function() {
      assert.equal('', util.randomAlphanumeric(0));
    }
  );

  it(
    'should generate an alphanumeric string of right length',
    function() {
      const alphanumeric = util.randomAlphanumeric(2048);
      assert.equal(alphanumeric.length, 2048);
      alphanumeric.replace(/[a-zA-Z0-9]/g, '');
      assert.equal(alphanumeric.replace(/[a-zA-Z0-9]/g, ''), '');
    }
  );

  it(
    'should get different strings when called twice',
    function() {
      const a1 = util.randomAlphanumeric();
      const a2 = util.randomAlphanumeric();
      assert.notEqual(a1, a2);
    }
  );

  it(
    'should regenerate th string if it has to many non-alphanumeric chars',
    function() {
      let count = 0;
      const rnd = function() {
        count++;
        if (count < 20) {
          const result = Buffer.from(
            '++++abcd////++++////++++////++++', 'base64'
          );
          return result;
        }
        return Buffer.from('0123456+/90123456789012345678901', 'base64');
      };
      const a = util.randomAlphanumeric(24, rnd);
      assert.equal(a, '012345690123456789012345');
      assert.equal(count, 20);
    }
  );
});

describe('generateGuid', function() {
  it('should correctly generate a guid', function() {
    const g = util.generateGuid('test_', 16);
    assert.equal(g.length, 21);
    assert.equal(g.substr(0, 5), 'test_');
  });
});

describe('generateEmailGuid', function() {
  it('should correctly generate an email guid', function() {
    const g1 = util.generateEmailGuid({}, {}, {}, 'test_', 24);
    assert.equal(g1, 'test_Ze5Ju8y944cXonU1fNUA1Zo1');
    const g2 = util.generateEmailGuid(
      {
        user: 'fu',
        host: 'fh'
      },
      {
        user: 'tu',
        host: 'th',
      },
      {
        'message-id': ['test-id'],
        'from': ['h@h'],
        'to': ['t1@a', 't2@a'],
        'subject': 'test-subject'
      },
      'test_',
      24
    );
    assert.equal(g2, 'test_iLYWvC1iH6z44aVtTrOUQZhl');
  });
});

describe('extractGuid', function() {
  it('should correctly extract guid', function() {
    assert(!util.extractGuid());
    assert(!util.extractGuid({}));
    assert.equal('g1', util.extractGuid({guid: 'g1'}));
    assert.equal('g2', util.extractGuid({
      transport: {guid: 'g2'}
    }));
    assert(!util.extractGuid({transport: {}}));
    assert(!util.extractGuid({transport: {target: {}}}));
    assert.equal('g3', util.extractGuid({transport: {target: {
      guid: 'g3'
    }}}));
    assert(!util.extractGuid({transport: {headers: {}}}));
    assert(!util.extractGuid({transport: {headers: {
      [util.GUID_HEADERNAME]: 5
    }}}));
    assert(!util.extractGuid({transport: {headers: {
      [util.GUID_HEADERNAME]: []
    }}}));
    assert(!util.extractGuid({transport: {headers: {
      [util.GUID_HEADERNAME]: ['a', 'b']
    }}}));
    assert.equal('g4', util.extractGuid({transport: {headers: {
      [util.GUID_HEADERNAME]: ['g4']
    }}}));
    assert.equal('g5', util.extractGuid({transport: {headers: {
      [util.GUID_HEADERNAME]: 'g5'
    }}}));
  });
});
