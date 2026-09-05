const assert = require('assert').strict;
const http = require('http');
const util = require('./lib/util');
const PostingJob = require('./lib/jobs/PostingJob');
const TestInbox = require('./lib/TestInbox');

describe('HTTP dependency compatibility', function() {
  this.timeout(5000);
  const proxyKeys = [
    'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
    'npm_config_proxy', 'npm_config_http_proxy', 'npm_config_https_proxy',
    'npm_config_no_proxy'
  ];
  let environment;
  let server;
  let sockets;
  let baseUrl;
  let requests;
  let respond;

  beforeEach(async function() {
    environment = new Map(proxyKeys.map(key => [key, process.env[key]]));
    for (const key of proxyKeys) {
      delete process.env[key];
    }
    process.env.NO_PROXY = '*';
    requests = [];
    sockets = new Set();
    respond = (req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({accepted: true}));
    };
    server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', chunk => chunks.push(chunk));
      req.on('end', () => {
        requests.push({
          url: req.url,
          method: req.method,
          headers: req.headers,
          body: Buffer.concat(chunks).toString()
        });
        respond(req, res);
      });
    });
    server.on('connection', socket => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
      socket.setTimeout(2000, () => socket.destroy());
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterEach(async function() {
    for (const [key, value] of environment) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise(resolve => server.close(resolve));
  });

  it('posts routing data and honors the first URL override', async () => {
    const routing = {
      baseUrl: `${baseUrl}/api/`,
      routingUri: '/routes',
      routingHeaders: {'X-Routing-Key': 'fixture'}
    };
    const transport = {guid: 'routing-fixture', headers: {}};
    assert.deepEqual(await util.fetchRoutingInfo(routing, transport), {
      accepted: true
    });
    assert.equal(requests[0].url, '/api/routes');
    assert.equal(requests[0].method, 'POST');
    assert.equal(requests[0].headers['x-routing-key'], 'fixture');
    assert.deepEqual(JSON.parse(requests[0].body), transport);

    transport.headers[util.DIRECT_DYNAMIC_ROUTING_URL_HEADERNAME] = [
      `${baseUrl}/override`, `${baseUrl}/unused`
    ];
    await util.fetchRoutingInfo(routing, transport);
    assert.equal(requests[1].url, '/override');
    assert.deepEqual(JSON.parse(requests[1].body), transport);
  });

  it('preserves PostingJob data and auth through a redirect', async () => {
    respond = (req, res) => {
      if (req.url === '/redirect') {
        res.writeHead(307, {Location: '/delivery'});
      } else {
        res.writeHead(204);
      }
      res.end();
    };
    const request = {
      url: `${baseUrl}/redirect`,
      method: 'put',
      auth: {username: 'fixture', password: 'fixture-password'},
      headers: {'X-Delivery-Key': 'fixture'},
      data: {transport: {guid: 'delivery-fixture'}, metadata: {attempt: 1}}
    };
    const original = JSON.parse(JSON.stringify(request));
    const logger = {info: () => {}, error: () => {}};
    const job = new PostingJob({request}, {logger});
    assert.equal(await job.process(), undefined);
    assert.deepEqual(requests.map(item => item.url), [
      '/redirect', '/delivery'
    ]);
    for (const item of requests) {
      assert.equal(item.method, 'PUT');
      assert.equal(item.headers['x-delivery-key'], 'fixture');
      assert.equal(item.headers.authorization,
        'Basic ' + Buffer.from('fixture:fixture-password').toString('base64'));
      assert.deepEqual(JSON.parse(item.body), request.data);
    }
    assert.deepEqual(request, original);
  });

  it('propagates routing and PostingJob HTTP rejections', async () => {
    respond = (req, res) => {
      res.writeHead(503);
      res.end('unavailable');
    };
    const rejected = err => err.response.status === 503;
    await assert.rejects(util.fetchRoutingInfo({
      baseUrl, routingUri: 'routing'
    }, {}), rejected);
    const errors = [];
    const job = new PostingJob({request: {url: `${baseUrl}/delivery`}}, {
      logger: {info: () => {}, error: (...args) => errors.push(args)}
    });
    await assert.rejects(job.process(), err => {
      assert.equal(errors[0][1].error, err.message);
      return rejected(err);
    });
    assert.equal(requests[1].method, 'POST');
    assert.equal(errors.length, 1);
  });

  it('uses TestInbox base URL, envelopes and caught count errors', async () => {
    const inbox = new TestInbox('receiver', 'Receiver', {
      baseUrl, mainDomain: 'example.com', group: null,
      auth: {username: 'fixture', password: 'fixture-password'}
    });
    let failCount = false;
    respond = (req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if (failCount) {
        res.writeHead(503);
        res.end(JSON.stringify({success: false}));
      } else {
        const result = req.url.endsWith('/count') ? 2 : [{id: '42'}];
        res.end(JSON.stringify({success: true, result}));
      }
    };
    assert.deepEqual(await inbox.getEmails(), [{id: '42'}]);
    assert.equal(await inbox.getEmailCount(), 2);
    assert.equal(requests[0].url,
      '/api/v1/inboxes/receiver@example.com/emails');
    assert.equal(requests[1].url,
      '/api/v1/inboxes/receiver@example.com/count');
    assert.equal(requests[0].method, 'GET');
    assert.equal(requests[0].headers.authorization,
      'Basic ' + Buffer.from('fixture:fixture-password').toString('base64'));
    failCount = true;
    const errors = await inbox.getEmailCount();
    assert.equal(errors.length, 1);
    assert.equal(errors[0].response.status, 503);
    respond = (req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({
        success: false, error: {message: 'fixture rejection'}
      }));
    };
    const envelopeErrors = await inbox.getEmailCount();
    assert.equal(envelopeErrors.length, 1);
    assert.match(envelopeErrors[0].message, /fixture rejection/);
  });
});
