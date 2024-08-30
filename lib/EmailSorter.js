const {getJsonSafeEmail, headerListToObject} = require('./util.js');
module.exports = class EmailSorter {
  constructor(item, mail) {
    this._item = item;
    this._mail = getJsonSafeEmail(mail);
    this._transport = item.transport;
  }

  getSortedOutEmails() {
    const mail = this._mail;
    let emails = [];
    for (const address of this._transport.rcpt_to) {
      emails.push(this._createEmailData(address, mail));
    }
    return emails;
  }

  _getTransportInfo(address) {
    const headers = headerListToObject(this._mail.headers || []);
    return {
      ...this._transport,
      headers,
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
