const axios = require('axios');
const {transportLogInfo} = require('./util.js');

module.exports = class PostingJob {
  constructor(item) {
    const url = item.request.url;
    const method = item.request.method || 'post';
    const headers = {
      ...(item.request.headers || {})
    };
    const auth = item.request.auth;
    const data = {
      ...(item.request.data || {})
    };
    let transport = data.transport;
    if (!transport && data.content) {
      //we are here because of notifications
      transport = data.content.transport;
    }

    this._logInfo = transportLogInfo(transport);
    this._request = {
      url,
      method,
      headers,
      auth,
      data
    };
  }

  async process() {
    try {
      // eslint-disable-next-line no-console
      console.info(
        `--- PostingJob --- url: ${this._request.url} ${this._logInfo}`
      );
      const response = await axios(this._request);

      // eslint-disable-next-line no-console
      console.info(
        `--- PostingJob response--- status: ${response.status} statusText: ` +
        `${response.statusText} url: ${this._request.url} ${this._logInfo}`
      );
    } catch (err) {
      const headersText = JSON.stringify(this._request.headers || {});
      console.error(
        `--- PostingJob error --- url: ${this._request.url} ` +
        ` headers: ${headersText} message: ${err.message} ${this._logInfo}`
      );
      throw err;
    }
  }
};
