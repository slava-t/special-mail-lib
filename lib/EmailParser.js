const addressparser = require('nodemailer/lib/addressparser');
const simpleParser = require('mailparser').simpleParser;
const Iconv = require('iconv').Iconv;
const EmailSorter = require('./EmailSorter.js');
const {getLogger} = require('./logger.js');
const {
  getRfc822Headers,
  getRfc822Message,
  emailToTransport,
  headerLinesToObject
} = require('./util.js');

const parseAddressHeader = function(headerValue) {
  if (typeof headerValue === 'string') {
    return {
      value: addressparser(headerValue),
      text: headerValue
    };
  }
};

const parsingHeaders = [
  ['x-loop', parseAddressHeader]
];

module.exports = class EmailParser {
  constructor(options = {}) {
    this._options = options;
    this._logger = getLogger(options);
  }

  //eml is a buffer
  async parse(eml, transport) {
    const mail = await simpleParser(eml, {Iconv});

    if (!transport) {
      transport = emailToTransport(mail);
    }

    const transportExt = {};
    if (!transport['rfc822_headers']) {
      const rfc822Headers = getRfc822Headers(mail);
      if (rfc822Headers) {
        transportExt['rfc822_headers'] = rfc822Headers;
      }
    }

    const mailExt = {};
    const rfc822Message = await getRfc822Message(mail);

    if (rfc822Message) {
      mailExt['rfc822_message'] = rfc822Message;
      if (!transportExt['rfc822_headers']) {
        transportExt['rfc822_headers'] = headerLinesToObject(
          rfc822Message.headerLines
        );
      }
    }
    const eml64 = eml.toString('base64');
    const messageId = transport['message_id'];
    if (!mail.headers.has('message-id') && messageId) {
      mail.headers.set('message-id', messageId);
    }
    for (const parsingHeader of parsingHeaders) {
      const newValue = parsingHeader[1](mail.headers.get(parsingHeader[0]));
      if (newValue) {
        mail.headers.set(parsingHeader[0], newValue);
      }
    }

    const sorter = new EmailSorter(
      {
        ...mailExt,
        eml64,
        mail,
        transport: {
          ...transport,
          ...transportExt
        }
      },
      mail
    );
    return sorter.getSortedOutEmails();
  }
};
