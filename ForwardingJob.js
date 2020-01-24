const Address = require('address-rfc2821').Address;
const DSN = require('haraka-dsn');
// eslint-disable-next-line camelcase
const {send_email} = require('./plugin-util.js');
const {transportLogInfo} = require('./util.js');

module.exports = class ForwardingJob {
  constructor(item, options) {
    this._plugin = options.plugin;
    this._srs = options.srs;
    this._item = item;
    this._logInfo = transportLogInfo(item.transport);
  }

  async process() {
    try {
      const mailFrom = this._item.transport.mail_from;
      const mailTo = this._item.transport.target;
      // eslint-disable-next-line no-console
      console.info(`--- ForwardingJob start --- ${this._logInfo}`);
      const sender = new Address(
        this._srs.rewrite(mailFrom.user, mailFrom.host),
        'mailtest.momentcrm.com'
      );
      // eslint-disable-next-line no-console
      console.info('--forwarding email-- sender=', sender.original);
      await send_email(
        this._plugin,
        //mailFrom.original,
        sender.original,
        mailTo.original,
        this._item.eml64,
        DSN.addr_bad_dest_system('Hrenogo')
      );
      // eslint-disable-next-line no-console
      console.info(
        `--- ForwardingJob done --- sender: ${sender.original}` +
        `${this._logInfo}`
      );
    } catch (err) {
      console.error('Forwarding job error:', err);
      throw err;
    }
  }
};
