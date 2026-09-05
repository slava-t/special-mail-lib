const assert = require('assert').strict;
const fs = require('fs').promises;
const http = require('http');
const os = require('os');
const path = require('path');
const {createRequire} = require('module');
const MailComposer = require('nodemailer/lib/mail-composer');
const EmailParser = require('./lib/EmailParser');
const createModel = require('./lib/mail-store-model');
const axiosRequire = createRequire(require.resolve('axios'));
const FormData = axiosRequire('form-data');
const sequelizeRequire = createRequire(require.resolve('sequelize'));
const lodash = sequelizeRequire('lodash');

describe('dependency security regressions', function() {
  this.timeout(5000);
  it('rejects lodash imports names containing default-parameter syntax', () => {
    assert.equal(lodash.template('<%= value %>', {
      imports: {value: 'fixture'}
    })(), 'fixture');
    // Harmless default-parameter syntax; no code is executed by this input.
    assert.throws(() => lodash.template('fixture', {
      imports: {'a=1': 1}
    }), /Invalid `imports`/);
  });

  for (const parameter of ['field name', 'filename']) {
    it(`keeps CR/LF in a multipart ${parameter} inside its header`, () => {
      const ordinary = new FormData();
      ordinary.append('attachment', Buffer.from('fixture-body'), {
        filename: 'fixture.txt'
      });
      assert.match(ordinary.getBuffer().toString(), /name="attachment"/);
      assert.match(ordinary.getBuffer().toString(), /filename="fixture.txt"/);

      const injected = 'fixture\r\nX-Injected: yes';
      const form = new FormData();
      form.append(parameter === 'field name' ? injected : 'attachment',
        Buffer.from('fixture-body'), {
          filename: parameter === 'filename' ? injected : 'fixture.txt'
        });
      const body = form.getBuffer().toString();
      const header = body.split('\r\n\r\n')[0];
      assert(!header.includes('\r\nX-Injected:'), header);
      assert(body.includes('fixture-body'));
    });
  }

  it('rejects invalid JSON cast types before SQL execution', async () => {
    const model = createModel('unused', {logging: false});
    try {
      const generator = model.sequelize.getQueryInterface().queryGenerator;
      const options = {model: model.TestEmail};
      const valid = generator.whereQuery({
        data: {'count::integer': 1}
      }, options);
      assert.match(valid, /CAST\(.+ AS INTEGER\)/);
      assert.throws(() => generator.whereQuery({
        data: {'count::not-a-type': 1}
      }, options), /Invalid cast type/);
    } finally {
      await model.sequelize.close();
    }
  });

  it('enforces disableFileAccess for raw message content', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sml-raw-mail-'));
    const file = path.join(directory, 'fixture.eml');
    const raw = 'Subject: Fixture\r\n\r\nHarmless file body\r\n';
    try {
      await fs.writeFile(file, raw);
      const allowed = await new MailComposer({raw: {path: file}})
          .compile().build();
      assert.equal(allowed.toString(), raw);
      await assert.rejects(new MailComposer({
        raw: {path: file}, disableFileAccess: true
      }).compile().build(), /File access rejected/);
    } finally {
      await fs.rm(directory, {recursive: true, force: true});
    }
  });

  it('enforces disableUrlAccess without fetching raw message content',
    async () => {
      const requests = [];
      const sockets = new Set();
      const raw = 'Subject: Fixture\r\n\r\nHarmless URL body\r\n';
      const server = http.createServer((req, res) => {
        requests.push(req.url);
        res.end(raw);
      });
      server.on('connection', socket => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        socket.setTimeout(2000, () => socket.destroy());
      });
      try {
        await new Promise((resolve, reject) => {
          server.once('error', reject);
          server.listen(0, '127.0.0.1', resolve);
        });
        const baseUrl = `http://127.0.0.1:${server.address().port}`;
        const allowed = await new MailComposer({
          raw: {href: baseUrl + '/allowed'}
        }).compile().build();
        assert.equal(allowed.toString(), raw);
        assert.deepEqual(requests, ['/allowed']);
        await assert.rejects(new MailComposer({
          raw: {href: baseUrl + '/blocked'}, disableUrlAccess: true
        }).compile().build(), /Url access rejected/);
        assert.deepEqual(requests, ['/allowed']);
      } finally {
        for (const socket of sockets) {
          socket.destroy();
        }
        await new Promise(resolve => server.close(resolve));
      }
    });

  it('handles bounded malformed nested groups in x-loop', async () => {
    const parser = new EmailParser();
    const parseLoop = value => parser.parse(Buffer.from([
      'From: sender@example.com',
      'To: receiver@example.com',
      'X-Loop: ' + value,
      '',
      'Body'
    ].join('\r\n')), {
      ['rcpt_to']: [{original: 'receiver@example.com'}]
    });
    const [ordinary] = await parseLoop('Team: Alice <alice@example.com>;');
    assert.deepEqual(ordinary.transport.headers['x-loop'][0].value, [{
      name: 'Team', group: [{address: 'alice@example.com', name: 'Alice'}]
    }]);
    // Under 16 KiB, without a timing assertion or an unbounded payload.
    const malformed = 'g:'.repeat(4096) + 'user@example.com;';
    const [bounded] = await parseLoop(malformed);
    assert.equal(bounded.transport.headers['x-loop'][0].text, malformed);
    assert(Array.isArray(bounded.transport.headers['x-loop'][0].value));
  });

  it('leaves a long URL as intact text while linking an ordinary URL',
    async () => {
      const longUrl = 'https://example.com/' + 'a'.repeat(5120);
      const shortUrl = 'https://example.com/short';
      const [item] = await new EmailParser().parse(Buffer.from([
        'From: sender@example.com',
        'To: receiver@example.com',
        'Content-Type: text/plain; charset=utf-8',
        '',
        longUrl + ' ' + shortUrl
      ].join('\r\n')), {
        ['rcpt_to']: [{original: 'receiver@example.com'}]
      });
      assert(item.mail.text.includes(longUrl));
      assert(item.mail.textAsHtml.includes(longUrl));
      assert(!item.mail.textAsHtml.includes('href="' + longUrl + '"'));
      assert(item.mail.textAsHtml.includes('href="' + shortUrl + '"'));
    });
});
