const axios = require('axios');
const Address = require('address-rfc2821').Address;
const urlJoin = require('url-join');
const jobTypes = require('./job-types.js');
const {
  DIRECT_DYNAMIC_ROUTING_URL_HEADERNAME,
  hashQueueName,
  getEnvironment,
  getDirectNotifyRequestRouting,
  getDirectPostRequestRouting
} = require('./util.js');

// eslint-disable-next-line camelcase
const {send_email, bounce_email} = require('./plugin-util.js');
const DSN = require('haraka-dsn');

module.exports = class RoutingJob {
  constructor(item, options) {
    this._options = options;
    this._queue = options.queue;
    this._plugin = options.plugin;
    this._resolver = options.resolver;
    this._environmentResolver = options.environmentResolver;
    this._routingConfig = options.routingConfig;
    this._item = item;
    this._mailTo = item.transport.target;
    this._mailFrom = item.transport.mail_from;
    this._targetDomain = this._mailTo.host;
    this._data = {...item};
    this._headers = item.transport.headers || {};
    this._directOptions = {
      headers: this._headers,
      directRoutingConfig: this._plugin.directRoutingConfig
    };
    delete this._data.job;
  }

  async process() {
    const self = this;

    try {
      const environment = getEnvironment(
        self._targetDomain,
        self._options
      );

      if (!environment) {
        await self._bounceUnauthorized();
        return;
      }

      if (!self._mailFrom.user) {
        await self._routeBouncedEmail(environment);
        return;
      }
      const res = self._resolver.createUrl(self._targetDomain);
      if (!res || res.index < 0) {
        //resolver could not resolve the target host
        //it might be a custom domain
        await self._routeWithCustomDomain(environment);

      } else {
        const request = {
          url: res.url,
          method: 'post',
          headers: res.headers,
          data: self._data
        };
        //just post to the res.url
        await self._queue.pushItem({
          job: jobTypes.POST,
          request: getDirectPostRequestRouting(request, self._directOptions)
        }, hashQueueName('mail-post-', res.url));
        await self._queue.notify(
          self._targetDomain,
          'in.queue.post',
          {transpot: self._item.transport},
          getDirectNotifyRequestRouting(self._directOptions)
        );
      }
    } catch (err) {
      console.error('Routing job error:', err);
      throw err;
    }
  }

  async _fetchRoutingInfo(environment) {
    const self = this;
    let routingUrl = urlJoin(environment.baseUrl, environment.routingUri);
    const directUrl = self._headers[DIRECT_DYNAMIC_ROUTING_URL_HEADERNAME];

    if (directUrl) {
      routingUrl = directUrl[0];
    }
    const requestResult = await axios({
      method: 'post',
      url: routingUrl,
      headers: environment.routingHeaders,
      data: self._item.transport
    });
    return requestResult.data;
  }

  async _routeWithCustomDomain(environment) {
    const self = this;
    // eslint-disable-next-line no-console
    console.info(
      '--routing email--- mail_from=',
      self._item.transport.mail_from
    );
    // eslint-disable-next-line no-console
    console.info(
      '--routing email--- mail_to=',
      self._item.transport.target
    );
    const routingInfo = await self._fetchRoutingInfo(environment);
    // eslint-disable-next-line no-console
    console.info('--routing email--- routingInfo=', routingInfo);
    if (routingInfo.post) {
      let url = urlJoin(environment.baseUrl, environment.emailPostUri);
      let headers = environment.emailPostHeaders;
      const request = {
        method: 'post',
        url,
        headers,
        data: self._data
      };
      await self._queue.pushItem({
        job: jobTypes.POST,
        request: getDirectPostRequestRouting(request, self._directOptions)
      }, hashQueueName('mail-post-', url));
    }
    if (routingInfo.forward) {
      await self._queue.pushItem({
        ...self._item,
        job: jobTypes.FORWARD
      }, 'mail-forward');
    }
    if (!(routingInfo.post || routingInfo.forward) && routingInfo.bounce) {
      // eslint-disable-next-line no-console
      console.info('--routing email--- bouncing...');
      await self._bounceUnauthorized();
    }
  }

  _bounce(dsn) {
    const self = this;
    return bounce_email(
      self._plugin,
      self._mailFrom.original,
      self._mailTo.original,
      self._item.eml64,
      dsn
    );
  }

  _bounceUnauthorized() {
    return this._bounce(
      DSN.sec_unauthorized('Delivery not authorized, message refused')
    );
  }

  async _routeBouncedEmail(environment) {
    let srsReverseValue = null;
    try {
      srsReverseValue = this._plugin.srs.reverse(this._mailTo.user);
    } catch (err) {
      console.error(err);
    }
    if (srsReverseValue) {
      await send_email(
        this._plugin,
        this._mailFrom,
        new Address(srsReverseValue[0], srsReverseValue[1]),
        this._item.eml64
      );
    }

    const url = urlJoin(environment.baseUrl, environment.emailPostUri);
    const headers = environment.emailPostHeaders;

    await this._queue.pushItem({
      job: jobTypes.POST,
      request: {
        method: 'post',
        url,
        headers,
        data: {
          ...this._data,
          transport: {
            ...this._data.transport,
            bounced: true
          }
        }
      }
    }, hashQueueName('mail-post-', url));
  }
};

