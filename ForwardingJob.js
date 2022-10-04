import {Address} from 'address-rfc2821';
import {getLogger} from './logger.js';
// eslint-disable-next-line camelcase
import {send_email} from './plugin-util.js';
import {transportLogInfo} from './util.js';

export default class ForwardingJob {
  constructor(item, options) {
    this._logger = getLogger(options);
    this._plugin = options.plugin;
    this._srs = options.srs;
    this._item = item;
    this._logInfo = transportLogInfo(item.transport);
  }

  async process() {
    try {
      const mailFrom = this._item.transport.mail_from;
      const mailTo = this._item.transport.target;
      this._logger.info(
        '--- ForwardingJob start ---',
        this._logInfo
      );
      const sender = new Address(
        this._srs.rewrite(mailFrom.user, mailFrom.host),
        'mailtest.momentcrm.com'
      );
      this._logger.info(
        '--- ForwardingJob got sender ---',
        {
          sender: sender.original,
          ...this._logInfo,
        }
      );

      await send_email(
        this._plugin,
        //mailFrom.original,
        sender.original,
        mailTo.original,
        this._item.eml64
      );
      this._logger.info(
        '--- ForwardingJob done ---',
        this._logInfo
      );
    } catch (err) {
      this._logger.error(`--- ForwardingJob error --- ${this._logInfo}`, err);
      throw err;
    }
  }
}
