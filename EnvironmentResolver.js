import {getLogger} from './logger.js';

export default class EnvironmentResolver {
  constructor(routingConfig) {
    this._logger = getLogger();
    this._routes = [];
    this._logger.info(
      '--EnvironmentResolver instantiation--',
      {routes: routingConfig.routes}
    );
    for (const route of routingConfig.routes || []) {
      if (!route.env) {
        throw new Error('A route without an environment found');
      }
      if (!route.domain) {
        throw new Error('A route without a domain found');
      }
      let re = route.domain;
      if (!(route.domain.startsWith('^') && route.domain.endsWith('$'))) {
        re = route.domain.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
      }
      this._routes.push({
        ...route,
        domain: new RegExp(re, 'gi')
      });
    }
  }

  resolve(domain) {
    if (domain) {
      for (const route of this._routes) {
        if (domain.match(route.domain)) {
          return route;
        }
      }
    }
  }
}
