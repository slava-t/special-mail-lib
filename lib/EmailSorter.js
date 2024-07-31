const {getJsonSafeEmail} = require('./util.js');
module.exports = class EmailSorter {
  constructor(item, mail) {
    this._item = item;
    this._mail = mail;
    this._transport = item.transport;
  }

  getSortedOutEmails() {
    const mail = getJsonSafeEmail(this._mail);
    let emails = [];
    for (const address of this._transport.rcpt_to) {
      emails.push(this._createEmailData(address, mail));
    }
    return emails;
  }

  _getTransportInfo(address) {
    return {
      ...this._transport,
      headers: this._mail.headers,
      ['parsed_headers']: true,
      target: address
    };
  }


  _createEmailData(address, mail) {
    return {
      ...this._item,
      mail,
      transport: this._getTransportInfo(address)
    };
  }
};
