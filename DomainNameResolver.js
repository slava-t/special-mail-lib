module.exports = class DomainNameResolver {
  constructor(config) {
    this.config = config;
    this.routes = [];
    this.proto = config.proto || 'https';
    this.port = config.port;
    this.uri = config.uri || '';
    this.headers = config.headers || {};

    for (const route of config.routes) {
      const domain = route['domain'];
      const target = route['target'];
      if (!target) {
        throw new Error('A route without a target found.');
      }
      if (!domain) {
        throw new Error('A route without a domain found.');
      }
      let re = domain;
      if (!(domain.startsWith('^') && domain.endsWith('$'))) {
        re = domain.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
      }
      this.routes.push({
        ...route,
        domain: new RegExp(re, 'gi'),
        target: target
      });
    }
  }

  getRouteCount() {
    let result = this.routes.length;
    if (this.defaultTarget) {
      ++result;
    }
    return result;
  }

  resolve(domain) {
    if (domain) {
      for (let i = 0; i < this.routes.length; ++i) {
        const route = this.routes[i];
        const re = route.domain;
        if (domain.match(re)) {
          return {
            index: i,
            target: domain.replace(re, route.target),
            proto: route.proto || this.proto,
            port: route.port || this.port,
            headers: route.headers || this.headers,
            uri: route.hasOwnProperty('uri') ? route.uri : this.uri
          };
        }
      }
    }
    if (this.defaultTarget) {
      return {
        index: -1,
        target: this.defaultTarget,
        proto: this.proto,
        port: this.port,
        headers: this.headers,
        uri: this.uri
      };
    }
  }

  canSolve(domain) {
    const result = this.resolve(domain);
    return result && result.index >= 0;
  }

  createUrl(domain) {
    const res = this.resolve(domain);
    if (!res) {
      return;
    }
    const port = res.port ? ':' + res.port : '';
    return {
      ...res,
      url: `${res.proto}://${res.target}${port}${res.uri}`,
    };
  }
};

