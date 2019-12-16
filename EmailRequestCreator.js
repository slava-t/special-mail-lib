const EmailSorter = require('./EmailSorter');

module.exports = class EmailRequestCreator {
  constructor(resolver, mail, transaction) {
    this._resolver = resolver;
    this._mail = mail;
    this._sorter = new EmailSorter(mail, transaction);
  }

  createRequests() {
    let requests = [];
    let defaultReq = null;
    const sortedEmails = this._sorter.getSortedOutEmails();
    for (const email of sortedEmails) {

      const res = this._resolver.createUrl(email.transport.target.host);
      if (!res) {
        continue;
      }

      const req = {
        url: res.url,
        method: 'post',
        headers: res.headers,
        data: email
      };
      if (res.index >= 0) {
        requests.push(req);
        break;
      } else if (!defaultReq) {
        defaultReq = req;
      }
    }
    if (requests.length === 0 && defaultReq) {
      requests.push(defaultReq);
    }
    return requests;
  }
};
