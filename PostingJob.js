import axios from 'axios';
import {transportLogInfo} from './util.js';
import {getLogger} from './logger.js';

export default class PostingJob {
  constructor(item, options) {
    this._logger = getLogger(options);
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
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      data
    };
  }

  async process() {
    try {
      this._logger.info(
        '--- PostingJob requesting ---',
        {url: this._request.url, ...this._logInfo}
      );
      const response = await axios(this._request);
      this._logger.info(
        '--- PostingJob response---',
        {
          status: response.status,
          statusText: response.statusText,
          url: this._request.url,
          ...this._logInfo
        }
      );
    } catch (err) {
      const headersText = JSON.stringify(this._request.headers || {});
      this._logger.error(
        '--- PostingJob error ---',
        {
          url: this._request.url,
          headers: headersText,
          error: err.message,
          ...this._logInfo
        }
      );
      throw err;
    }
  }
}
