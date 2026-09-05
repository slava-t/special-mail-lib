const assert = require('assert').strict;
const dns = require('dns');
const spfCheck = require('spf-check');
const DomainNameVerifier = require('./lib/DomainNameVerifier');
const {createError} = require('./lib/error');

describe('SPF dependency compatibility', function() {
  let originalResolve;
  let originalCheck;
  let verifier;
  let checks;
  let activeChecks;
  let corrections;
  let lookups;
  const mailServers = ['allowed.example.com', 'denied.example.com'];
  const spfInclude = 'spf.example.com';
  const step = {step: 'SpfChangeDnsRecord', message: 'fixture correction'};

  beforeEach(function() {
    originalResolve = dns.resolve;
    originalCheck = spfCheck.SPF.prototype.check;
    checks = [];
    activeChecks = 0;
    corrections = [];
    lookups = [];
    verifier = new DomainNameVerifier('/unused', {
      environments: {fixture: {mailServers, spfInclude}}
    });
    verifier._getAllMailServersIps = servers => {
      assert.deepEqual(servers, mailServers);
      return Promise.resolve({errors: [], steps: [], ips: [
        {server: mailServers[0], ip: '192.0.2.1'},
        {server: mailServers[1], ip: '192.0.2.2'},
        {server: mailServers[1], ip: '192.0.2.3'}
      ]});
    };
    // Observe the decision; DNS-based message construction is separate.
    verifier._createSetSpfStep = (...args) => {
      corrections.push(args);
      return Promise.resolve(step);
    };
    dns.resolve = (hostname, rrtype, callback) => {
      lookups.push([hostname, rrtype]);
      assert.equal(hostname, 'example.com');
      assert.equal(rrtype, 'TXT');
      setImmediate(() => callback(null, [['v=spf1 ip4:192.0.2.1 -all']]));
    };
    spfCheck.SPF.prototype.check = async function(ip) {
      assert.equal(activeChecks, 0);
      activeChecks++;
      try {
        const result = await originalCheck.call(this, ip);
        checks.push([ip, result.result]);
        return result;
      } finally {
        activeChecks--;
      }
    };
  });

  afterEach(function() {
    dns.resolve = originalResolve;
    spfCheck.SPF.prototype.check = originalCheck;
  });

  it('checks real SPF/parser results in order and requests one correction',
    async () => {
      const result = await verifier._verifySpf('fixture', 'example.com');
      assert.deepEqual(checks, [
        ['192.0.2.1', 'Pass'], ['192.0.2.2', 'Fail'], ['192.0.2.3', 'Fail']
      ]);
      assert.equal(result.errors.length, 2);
      assert.deepEqual(result.errors.map(err => err.error), [
        'SpfFailed', 'SpfFailed'
      ]);
      assert.deepEqual(result.errors.map(err => err.params.slice(0, 4)), [
        ['example.com', mailServers[1], '192.0.2.2', 'Fail'],
        ['example.com', mailServers[1], '192.0.2.3', 'Fail']
      ]);
      assert.deepEqual(result.steps, [step]);
      assert.deepEqual(corrections, [[spfInclude, mailServers, 'example.com']]);
      assert.equal(lookups.length, 3);
    });

  it('returns successful SPF without a correction', async () => {
    verifier._getAllMailServersIps = () => Promise.resolve({
      errors: [], steps: [], ips: [{server: mailServers[0], ip: '192.0.2.1'}]
    });
    assert.deepEqual(await verifier._verifySpf('fixture', 'example.com'), {
      errors: [], steps: []
    });
    assert.deepEqual(checks, [['192.0.2.1', 'Pass']]);
    assert.deepEqual(corrections, []);
  });

  it('short-circuits SPF after A-record failure', async () => {
    const errors = [createError('DnsGettingARecordsFailed', mailServers[0])];
    const steps = [{step: 'MxAskSupport', message: 'Ask support for help'}];
    verifier._getAllMailServersIps = () => Promise.resolve({
      errors, steps, ips: [{server: mailServers[0], ip: '192.0.2.1'}]
    });
    assert.deepEqual(await verifier._verifySpf('fixture', 'example.com'), {
      errors, steps
    });
    assert.deepEqual(checks, []);
    assert.deepEqual(lookups, []);
    assert.deepEqual(corrections, []);
  });
});
