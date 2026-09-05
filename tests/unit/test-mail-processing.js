const assert = require('assert').strict;
const EmailParser = require('./lib/EmailParser');
const {emailToTransport} = require('./lib/util');

const message = (headers, body) => Buffer.from([
  'From: Sender <SENDER@Example.COM>',
  'To: Receiver <RECEIVER@Example.COM>',
  'MIME-Version: 1.0',
  ...headers,
  '',
  body
].join('\r\n'));

const multipart = parts => message([
  'Content-Type: multipart/mixed; boundary="mail-fixture"'
], parts.map(part => '--mail-fixture\r\n' + part).join('\r\n') +
  '\r\n--mail-fixture--\r\n');

const suppliedTransport = () => emailToTransport({
  from: 'SENDER@Example.COM', to: 'RECEIVER@Example.COM'
});

describe('mail dependency compatibility', function() {
  it('parses groups and x-loop into ordered recipient transports', async () => {
    const eml = Buffer.from([
      'From: =?UTF-8?Q?Jos=C3=A9?= <SENDER@Example.COM>',
      'To: Team: Alice <ALICE@Example.COM>, Bob <BOB@Example.COM>;',
      'Cc: Copy <COPY@Example.COM>',
      'X-Loop: Loop <LOOP@Example.COM>',
      'Subject: =?UTF-8?Q?Caf=C3=A9?=',
      'Message-ID: <fixture@example.com>',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Ordinary mail body'
    ].join('\r\n'));
    const items = await new EmailParser().parse(eml, emailToTransport({
      from: 'SENDER@Example.COM',
      to: 'Team: Alice <ALICE@Example.COM>, Bob <BOB@Example.COM>;',
      cc: 'COPY@Example.COM'
    }));
    assert.deepEqual(items.map(item => item.transport.target.original), [
      'alice@example.com', 'bob@example.com', 'copy@example.com'
    ]);
    const first = items[0];
    assert.equal(first.transport.mail_from.user, 'sender');
    assert.equal(first.transport.mail_from.host, 'example.com');
    assert.equal(first.mail.from.value[0].name, 'José');
    assert.equal(first.mail.to.value[0].name, 'Team');
    assert.equal(first.mail.to.value[0].group.length, 2);
    assert.deepEqual(first.transport.headers.subject, ['Café']);
    assert.deepEqual(first.transport.headers['message-id'], [
      '<fixture@example.com>'
    ]);
    assert.deepEqual(first.transport.headers['x-loop'][0], {
      value: [{address: 'LOOP@Example.COM', name: 'Loop'}],
      text: 'Loop <LOOP@Example.COM>'
    });
    assert.equal(first.mail.text.trim(), 'Ordinary mail body');
    assert.equal(first.eml64, eml.toString('base64'));
    assert(Array.isArray(first.mail.headers));
    assert(!Object.hasOwn(first, 'rfc822_message'));
    assert(!Object.hasOwn(first.transport, 'rfc822_headers'));
    for (const [index, item] of items.entries()) {
      assert.equal(item.mail, first.mail);
      assert.equal(item.transport.rcpt_to, first.transport.rcpt_to);
      assert.equal(item.transport.target, first.transport.rcpt_to[index]);
      assert.equal(item.transport.parsed_headers, true);
      assert.deepEqual(item.transport.headers, first.transport.headers);
    }
    assert.notEqual(items[1].transport.headers, first.transport.headers);
    assert.doesNotThrow(() => JSON.stringify(items));
  });

  it('preserves the empty synthesized envelope for parsed address objects',
    async () => {
      // MailComposer takes address definitions, while Mailparser supplies
      // containers with a value array. The current implicit path yields no
      // recipients; callers provide an envelope for per-recipient delivery.
      assert.deepEqual(await new EmailParser().parse(message([], 'Body')), []);
    });

  it('preserves transport aliases and message-id guards', async () => {
    const recipients = [
      {original: 'second@example.com', host: 'example.com', user: 'second'},
      {original: 'first@example.com', host: 'example.com', user: 'first'}
    ];
    const incomingHeaders = {subject: ['incoming']};
    const metadata = {attempt: 2};
    for (const parsedId of [undefined, '<parsed@example.com>']) {
      const transport = {
        ['rcpt_to']: recipients,
        ['mail_from']: {original: 'envelope@example.com'},
        ['message_id']: '<supplied@example.com>',
        headers: incomingHeaders,
        metadata
      };
      const eml = message(parsedId ? ['Message-ID: ' + parsedId] : [], 'Body');
      const items = await new EmailParser().parse(eml, transport);
      assert.equal(items.length, 2);
      for (const [index, item] of items.entries()) {
        assert.equal(item.transport.target, recipients[index]);
        assert.equal(item.transport.rcpt_to, recipients);
        assert.equal(item.transport.mail_from, transport.mail_from);
        assert.equal(item.transport.metadata, metadata);
        assert.equal(item.mail, items[0].mail);
        assert.deepEqual(item.transport.headers['message-id'], [
          parsedId || '<supplied@example.com>'
        ]);
      }
      assert.equal(transport.headers, incomingHeaders);
      assert.deepEqual(transport.headers, {subject: ['incoming']});
    }
    const [withoutId] = await new EmailParser().parse(message([], 'Body'), {
      ['rcpt_to']: recipients
    });
    assert(!Object.hasOwn(withoutId.transport.headers, 'message-id'));
  });

  it('composes grouped headers and honors explicit envelope overrides', () => {
    const email = {
      from: 'José <SENDER@Example.COM>',
      to: 'Team: Alice <ALICE@Example.COM>, Bob <BOB@Example.COM>;',
      cc: 'Copy <COPY@Example.COM>',
      subject: 'Composer fixture',
      messageId: '<composer@example.com>',
      headers: {'X-Fixture': 'preserved'},
      text: 'Body'
    };
    const grouped = emailToTransport(email);
    assert.deepEqual(grouped.rcpt_to.map(address => address.original), [
      'alice@example.com', 'bob@example.com', 'copy@example.com'
    ]);
    assert.equal(grouped.mail_from.original, 'sender@example.com');
    assert.deepEqual(grouped.headers.subject, ['Composer fixture']);
    assert.deepEqual(grouped.headers['x-fixture'], ['preserved']);
    assert.deepEqual(grouped.headers['message-id'], ['<composer@example.com>']);
    assert.match(grouped.headers.to[0], /Team:/);
    const overridden = emailToTransport({
      ...email,
      envelope: {
        from: 'BOUNCE@Example.COM',
        to: ['SECOND@Example.COM', 'FIRST@Example.COM']
      }
    });
    assert.equal(overridden.mail_from.original, 'bounce@example.com');
    assert.deepEqual(overridden.rcpt_to.map(address => address.original), [
      'second@example.com', 'first@example.com'
    ]);
    assert.deepEqual(overridden.headers.to, grouped.headers.to);
    assert.deepEqual(overridden.headers.from, grouped.headers.from);
  });

  it('derives meaningful text from HTML and decodes entities', async () => {
    const [item] = await new EmailParser().parse(message([
      'Content-Type: text/html; charset=utf-8'
    ], '<p>Café &amp; tea &#8364;</p><p><b>Second paragraph</b></p>'),
    suppliedTransport());
    assert.match(item.mail.text, /Café & tea €/);
    assert.match(item.mail.text, /Second paragraph/);
    assert.match(item.mail.html, /Café &amp; tea/);
  });

  it('decodes ISO-2022-JP using the parser Iconv option', async () => {
    // 日本語 in ISO-2022-JP, which needs native Iconv rather than iconv-lite.
    const body = Buffer.from('1b2442467c4b5c386c1b2842', 'hex');
    const [item] = await new EmailParser().parse(message([
      'Content-Type: text/plain; charset=iso-2022-jp',
      'Content-Transfer-Encoding: base64'
    ], body.toString('base64')), suppliedTransport());
    assert.equal(item.mail.text.trim(), '日本語');
  });

  it('preserves multipart text and attachment projections', async () => {
    const bytes = Buffer.from([0, 1, 127, 128, 255]);
    const eml = multipart([
      'Content-Type: text/plain; charset=utf-8\r\n\r\nMultipart café',
      [
        'Content-Type: application/octet-stream; name="bytes.bin"',
        'Content-Disposition: attachment; filename="bytes.bin"',
        'Content-Transfer-Encoding: base64',
        '',
        bytes.toString('base64')
      ].join('\r\n')
    ]);
    const [item] = await new EmailParser().parse(eml, suppliedTransport());
    assert.equal(item.mail.text.trim(), 'Multipart café');
    assert.equal(item.mail.attachments.length, 1);
    const attachment = item.mail.attachments[0];
    assert.deepEqual(Object.keys(attachment).sort(), [
      'filename', 'contentType', 'contentDisposition', 'checksum', 'content',
      'size', 'headers', 'contentId', 'cid', 'related'
    ].sort());
    assert.equal(attachment.filename, 'bytes.bin');
    assert.equal(attachment.contentType, 'application/octet-stream');
    assert.equal(attachment.contentDisposition, 'attachment');
    assert.equal(attachment.size, bytes.length);
    assert.deepEqual(Buffer.from(attachment.content, 'base64'), bytes);
    assert(Array.isArray(attachment.headers));
    assert.equal(JSON.parse(JSON.stringify(item)).mail.attachments[0].content,
      bytes.toString('base64'));
  });

  const headersPart = subject => [
    'Content-Type: text/rfc822-headers',
    'Content-Disposition: attachment',
    '',
    'Subject: ' + subject,
    'X-Trace: first',
    'X-Trace: second',
    ''
  ].join('\r\n');
  const embeddedPart = subject => [
    'Content-Type: message/rfc822',
    'Content-Disposition: attachment',
    '',
    message(['Subject: ' + subject], 'Embedded body').toString()
  ].join('\r\n');

  it('selects the first headers and embedded-message attachments', async () => {
    const eml = multipart([
      headersPart('=?UTF-8?Q?Caf=C3=A9?='), headersPart('Ignored headers'),
      embeddedPart('First embedded'), embeddedPart('Ignored embedded')
    ]);
    const [item] = await new EmailParser().parse(eml, {
      ['rcpt_to']: [{original: 'receiver@example.com'}]
    });
    assert.deepEqual(item.transport.rfc822_headers.subject, [
      '=?UTF-8?Q?Caf=C3=A9?='
    ]);
    assert.deepEqual(item.transport.rfc822_headers['x-trace'], [
      'first', 'second'
    ]);
    assert.equal(item.rfc822_message.subject, 'First embedded');
    assert.equal(item.rfc822_message.text.trim(), 'Embedded body');
    assert(Array.isArray(item.rfc822_message.headers));
    assert.deepEqual(item.rfc822_message.attachments, []);
    assert.equal(JSON.parse(JSON.stringify(item)).rfc822_message.subject,
      'First embedded');
  });

  it('allows embedded headers to replace incoming RFC822 headers', async () => {
    const incoming = {subject: ['Incoming']};
    const transport = {
      ['rcpt_to']: [{original: 'receiver@example.com'}],
      ['rfc822_headers']: incoming
    };
    const [item] = await new EmailParser().parse(multipart([
      headersPart('Attachment headers'), embeddedPart('Embedded headers')
    ]), transport);
    assert.deepEqual(item.transport.rfc822_headers.subject, [
      'Embedded headers'
    ]);
    assert.equal(transport.rfc822_headers, incoming);
    assert.deepEqual(incoming, {subject: ['Incoming']});
    const [headersOnly] = await new EmailParser().parse(multipart([
      headersPart('Attachment headers')
    ]), transport);
    assert.equal(headersOnly.transport.rfc822_headers, incoming);
    assert(!Object.hasOwn(headersOnly, 'rfc822_message'));
  });

  it('derives RFC822 headers from an embedded message without a headers part',
    async () => {
      const [item] = await new EmailParser().parse(multipart([
        embeddedPart('Embedded only')
      ]), suppliedTransport());
      assert.deepEqual(item.transport.rfc822_headers.subject, [
        'Embedded only'
      ]);
      assert.equal(item.rfc822_message.subject, 'Embedded only');
    });
});
