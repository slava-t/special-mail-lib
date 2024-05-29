const EmailParser = require('../EmailParser');
const jobTypes = require('./job-types.js');
const {getLogger} = require('../logger.js');
const {getDirectNotifyRequestRouting, transportLogInfo} = require('../util.js');

module.exports = class EmailParsingJob {
  constructor(item, options) {
    this._logger = getLogger(options);
    this._item = item;
    this._plugin = options.plugin;
    this._queue = options.queue;
    this._notifyOptions = getDirectNotifyRequestRouting({
      headers: item.transport.headers,
      directRoutingConfig: this._plugin.directRoutingConfig
    });
    this._logInfo = transportLogInfo(item.transport);
    this._emailParser = new EmailParser();
  }

  async process() {
    let emails = [];
    const transport = this._item.transport;
    try {
      const eml = Buffer.from(this._item.eml64, 'base64');
      emails = await this._emailParser.parse(eml, transport);
    } catch (err) {
      this._logger.error(
        'An error occurred while parsing the email',
        this._logInfo,
        err
      );
      await this._queue.notify(
        transport['rcpt_to'],
        'in.job.parse.fail.parse',
        this._item.transport
      );
      //there is nothing to do. Just let the job to be removed
      return;
    }

    this._logger.info(
      '--- EmailParsingJob parsed---',
      this._logInfo
    );

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

        this._logger.info(
          '--- EmailParsingJob queued---',
          transportLogInfo(email.transport)
        );
      } catch (err) {
        this._logger.error(
          `--- EmailParsingJob error--- ${transportLogInfo(this._logInfo)}`,
          err
        );
        await this._queue.notify(
          email.transport.target,
          'in.queue.fail.route',
          email.transport
        );
      }
    }
  }
};
