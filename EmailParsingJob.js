const simpleParser = require('mailparser').simpleParser;
const Iconv = require('iconv').Iconv;
const EmailSorter = require('./EmailSorter');
const jobTypes = require('./job-types.js');
const {getDirectNotifyRequestRouting} = require('./util.js');

module.exports = class EmailParsingJob {
  constructor(item, options) {
    this._item = item;
    this._plugin = options.plugin;
    this._queue = options.queue;
    this._notifyOptions = getDirectNotifyRequestRouting({
      headers: item.transport.headers,
      directRoutingConfig: this._plugin.directRoutingConfig
    });
  }

  async process() {
    let mail = null;
    const transport = this._item.transport;
    try {
      const eml = new Buffer(this._item.eml64, 'base64');
      mail = await simpleParser(eml, {Iconv});
    } catch (err) {
      console.error(err);
      await this._queue.notify(
        transport['rcpt_to'],
        'in.job.parse.fail.parse',
        this._item.transport
      );
      //there is nothing to do. Just let the job to be removed
      return;
    }
    const sorter = new EmailSorter(this._item, mail);
    const emails = sorter.getSortedOutEmails();
    for (const email of emails) {
      try {
        const newItem = {
          ...this._item,
          mail: email.mail,
          transport: email.transport,
          job: jobTypes.ROUTE
        };
        await this._plugin.queue.pushItem(newItem, 'mail-route');
        await this._queue.notify(
          email.transport.target,
          'in.queue.route',
          {transport: email.transport},
          this._notifyOptions
        );
      } catch (err) {
        console.error(err);
        await this._queue.notify(
          email.transport.target,
          'in.queue.fail.route',
          email.transport
        );
      }
    }
  }
};
