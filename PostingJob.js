const axios = require('axios');

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
      console.info('--posting job-- url=', this._request.url);
      const response = await axios(this._request);

      // eslint-disable-next-line no-console
      console.info('--posting job-- response=', {
        status: response.status,
        statusText: response.statusText
      });

    } catch (err) {
      console.error('Posting job error:', err);
    }
  }
};
