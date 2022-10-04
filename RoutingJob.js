import axios from 'axios';
import {Address} from 'address-rfc2821';
import urlJoin from 'url-join';
import jobTypes from './job-types.js';
import {getLogger} from './logger.js';
import {
  DIRECT_DYNAMIC_ROUTING_URL_HEADERNAME,
  hashQueueName,
  getEnvironment,
  getDirectNotifyRequestRouting,
  getDirectPostRequestRouting,
  transportLogInfo
} from './util.js';

// eslint-disable-next-line camelcase
import {send_email, bounce_email} from './plugin-util.js';
import DSN from 'haraka-dsn';

export default class RoutingJob {
  constructor(item, options) {
    this._logger = getLogger(options);
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
    this._logInfo = transportLogInfo(item.transport);
    delete this._data.job;
  }

  async process() {
    const self = this;

    try {
      self._logger.info('--- RoutingJob start--- ', self._logInfo);

      const res = self._resolver.createUrl(self._targetDomain);
      if (res && res.index >= 0) {
        self._logger.info(
          '--- RoutingJob static routing start ---',
          self._logInfo
        );

        let request = getDirectPostRequestRouting(
          {
            url: res.url,
            method: 'post',
            headers: res.headers,
            data: self._data
          },
          self._directOptions
        );

        //just post to the res.url
        await self._queue.pushTrackedItem({
          job: jobTypes.POST,
          request
        }, hashQueueName('mail-post-', res.url));

        await self._queue.notify(
          self._targetDomain,
          'in.queue.post',
          {transport: self._item.transport},
          getDirectNotifyRequestRouting(self._directOptions)
        );
        self._logger.info(
          '--- RoutingJob static routing queued for posting ---',
          {url: request.url, ...self._logInfo}
        );

        return;
      }

      self._logger.info(
        '--- RoutingJob dynamic routing start ---',
        self._logInfo
      );

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

      //resolver could not resolve the target host
      //it might be a custom domain
      await self._routeWithCustomDomain(environment);

    } catch (err) {
      self._logger.error(
        `--- RoutingJob error --- ${self._logInfo}`,
        err
      );
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
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      data: self._item.transport
    });
    return requestResult.data;
  }

  async _routeWithCustomDomain(environment) {
    const self = this;

    const routingInfo = await self._fetchRoutingInfo(environment);
    self._logger.info(
      '--- RoutingJob dynamic routing ---',
      {routingInfo, ...self._logInfo}
    );
    let ignore = true;
    if (routingInfo.post) {
      ignore = false;
      const url = urlJoin(environment.baseUrl, environment.emailPostUri);
      const headers = environment.emailPostHeaders;
      const request = getDirectPostRequestRouting(
        {
          method: 'post',
          url,
          headers,
          data: self._data
        },
        self._directOptions
      );
      await self._queue.pushTrackedItem({
        job: jobTypes.POST,
        request
      }, hashQueueName('mail-post-', url));

      await self._queue.notify(
        self._targetDomain,
        'in.queue.post',
        {transport: self._item.transport},
        getDirectNotifyRequestRouting(self._directOptions)
      );

      self._logger.info(
        '--- RoutingJob dynamic routing queued for posting ---',
        {url: request.url, ...self._logInfo}
      );
    }
    if (routingInfo.forward) {
      ignore = false;
      await self._queue.pushItem({
        ...self._item,
        job: jobTypes.FORWARD
      }, 'mail-forward');

      const forwardingType =
          routingInfo.post ? 'in.queue.forward' : 'in.queue.forward.close';

      await self._queue.notify(
        self._targetDomain,
        forwardingType,
        {transport: self._item.transport},
        getDirectNotifyRequestRouting(self._directOptions)
      );
      self._logger.info(
        '--- RoutingJob dynamic routing queued for forwarding ---',
        self._logInfo
      );
    }
    if (!(routingInfo.post || routingInfo.forward) && routingInfo.bounce) {
      ignore = false;
      self._logger.info(
        '--- RoutingJob dynamic routing start bouncing ---',
        self._logInfo
      );
      await self._bounceUnauthorized();
      await self._queue.notify(
        self._targetDomain,
        'in.queue.bounce',
        {transport: self._item.transport},
        getDirectNotifyRequestRouting(self._directOptions)
      );
    }
    if (ignore) {
      self._logger.info(
        '--- RoutingJob dynamic routing ignoring ---',
        self._logInfo
      );
      await self._queue.notify(
        self._targetDomain,
        'in.ignore',
        {transport: self._item.transport},
        getDirectNotifyRequestRouting(self._directOptions)
      );
    }
  }

  _bounce(dsn) {
    const self = this;
    return bounce_email(
      self._plugin,
      self._mailFrom.original,
      self._mailTo.original,
      self._headers,
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
      this._logger.error(err, this._logInfo);
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

    await this._queue.pushTrackedItem({
      job: jobTypes.POST,
      request: {
        method: 'post',
        url,
        headers,
        data: this._data
      }
    }, hashQueueName('mail-post-', url));
  }
}

