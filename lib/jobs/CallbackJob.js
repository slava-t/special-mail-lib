const {getLogger} = require('../logger.js');
module.exports = class CallbackJob {
  constructor(item, options) {
    this._logger = getLogger(options);
    this._arg = item.arg;
    this._callback = options.callback;
  }
  async process() {
    try {
      await this._callback(this._arg);
    } catch (err) {
      this._logger.error(
        '--- CallbackJob error ---',
        {
          arg: this._arg,
          callback: this._callback
        }
      );
    }
  }
};
