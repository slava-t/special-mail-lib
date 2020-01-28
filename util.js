const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const dns = require('dns');
const util = require('util');
const yaml = require('yaml');
const merge = require('merge');
const {Base64} = require('js-base64');
const addressParser = require('addressparser');
const Address = require('address-rfc2821').Address;

const EnvironmentResolver = require('./EnvironmentResolver');
const DomainNameResolver = require('./DomainNameResolver');

const asyncReadFile = util.promisify(fs.readFile);

exports.DIRECT_CONFIG_HEADERNAME = 'x-debuggex-direct-routing-config';
exports.DIRECT_POST_URL_HEADERNAME = 'x-debuggex-direct-routing-post-url';
exports.DIRECT_NOTIFY_URL_HEADERNAME = 'x-debuggex-direct-routing-notify-url';
exports.DIRECT_DYNAMIC_ROUTING_URL_HEADERNAME =
  'x-debuggex-direct-dynamic-routing-url';
exports.JSON64_DATA_HEADERNAME = 'x-postboy-json64-data';

exports.asyncWrapper = function(func) {
  return function(req, res, next) {
    Promise.resolve(func(req, res, next)).catch(next);
  };
};

exports.clearInboxes = async function(inboxes) {
  let errors = 0;
  while (inboxes.length) {
    const inbox = inboxes.pop();
    try {
      await inbox.clear();
    } catch (err) {
      console.error(err);
    }
  }
  if (errors) {
    errors = 0;
    throw new Error('There are errors during inboxes cleanup.');
  }
};

exports.errorHandler = function(err, req, res, next) {
  if (res.headersSent) {
    return next(err);
  }
  res.status(500);
  res.send({
    success: false,
    error: {
      name: err.name,
      message: err.message,
      text: err.toString(),
      stack: err.stack
    }
  });
};

exports.ok = function(res, result) {
  res.status(200).send({success: true, result});
};

exports.hashQueueName = function(base, index) {
  return base + crypto.createHash('md5').update(
    index.toString()
  ).digest('hex')[0];
};

exports.parseRoutingConfig = function(data) {
  const combine = function(commonField, sourceField) {
    const source = data[sourceField] || {};
    const common = data[commonField] || {};
    const result = {};
    Object.keys(source).map(function(sourcePropId) {
      result[sourcePropId] = {
        ...common,
        ...source[sourcePropId]
      };
    });
    return result;
  };

  return {
    ...data,
    environments: combine('environmentCommon', 'environments')
  };
};


exports.getDomainHashKey = function(domain, len = 2) {
  const normalizedDomain = domain.toLowerCase().replace(/\./g, ' ').trim();
  const hash = crypto.createHash('sha256').update(
    normalizedDomain
  ).digest('hex');
  return hash.substr(0, len).toLowerCase();
};

exports.getDkimDir = function(configDir, domain, defaultDkim = false) {
  const folderName = defaultDkim ?
    'default' : exports.getDomainHashKey(domain, 2);
  return path.join(configDir, 'dkim', folderName);
};

exports.getDkim = async function(dir, domain, config, defaultDkim = false) {
  const dkimDir = exports.getDkimDir(dir, domain, defaultDkim);
  const textPath = path.join(dkimDir, 'txt');
  const id = path.basename(dkimDir);
  const selector = config.dkimSelector || 'moment';
  const dkimDomain = `${selector}._domainkey.${domain}`;
  const value = await asyncReadFile(textPath, 'utf8');
  return {
    id,
    selector,
    domain: dkimDomain,
    value: value.trim()
  };
};

exports.dnsResolve = function(hostname, recordType, timeout = 20000) {
  return new Promise(function(resolve, reject) {
    const dnsResolver = new dns.Resolver();
    //dnsResolver.setServers(['4.4.4.4', '8.8.8.8', '8.8.4.4']);
    let resolved = false;
    let timeoutHandle = setTimeout(function() {
      timeoutHandle = null;
      if (!resolved) {
        resolved = true;
        reject(new Error('The dns resolve request timed out'));
        dnsResolver.cancel();
      }
    }, timeout);
    dnsResolver.resolve(hostname, recordType, function(err, records) {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }

      if (!resolved) {
        resolved = true;
        if (err) {
          return reject(err);
        }
        return resolve(records);
      }
    });
  });
};

// This function will transform an array of promises in such a way that when
// the array is passed to Promise.all it will behave exactly as if the
// original array is passed to Promise.allSettled. The later one is available
// only in node 12.9.0 and later. When we upgrade we should get rid of
// this function and use Promis.allSettled instead.
exports.allPromises = function(promises) {
  return promises.map(p => new Promise(function(resolve) {
    p.then(function(value) {
      return resolve({
        status: 'fulfilled',
        value
      });
    }).catch(function(err) {
      return resolve({
        status: 'rejected',
        reason: err
      });
    });
  }));
};

exports.copyStream = function(source, dest) {
  return new Promise(function(resolve, reject) {
    dest.on('finish', function() {
      resolve();
    });
    dest.on('error', function(err) {
      reject(err);
    });
    source.on('error', function(err) {
      reject(err);
    });
    source.pipe(dest);
  });
};


exports.getMailServers = function(routingConfig) {
  const result = new Set();
  const environments = routingConfig.environments || {};
  for (const environment of Object.keys(environments)) {
    const servers = environments[environment].mailServers || [];
    for (const server of servers) {
      result.add(server.toLowerCase());
    }
  }
  return result;
};

exports.getEnvironment = function(targetDomain, options) {
  const envResult = options.environmentResolver.resolve(targetDomain);

  if (envResult) {
    return options.routingConfig.environments[envResult.env];
  }
};

exports.createResolvers = function(configDir) {
  const resolverConfig = yaml.parse(
    fs.readFileSync(path.join(configDir, 'domain-resolver.yaml'), 'utf8')
  );
  const resolver = new DomainNameResolver(resolverConfig);

  const routingConfig = exports.parseRoutingConfig(yaml.parse(
    fs.readFileSync(path.join(configDir, 'routing.yaml'), 'utf8')
  ));

  const directRoutingConfig = yaml.parse(
    fs.readFileSync(path.join(configDir, 'direct-routing.yaml'), 'utf8')
  );
  const environmentResolver = new EnvironmentResolver(routingConfig);

  return {
    resolver,
    resolverConfig,
    environmentResolver,
    routingConfig,
    directRoutingConfig
  };
};


exports.getDirectNotifyRequestRouting = function(options = {}) {
  const headers = options.headers || {};

  const result = {};
  const directNotificationUrl = headers[exports.DIRECT_NOTIFY_URL_HEADERNAME];
  if (directNotificationUrl) {
    result.directNotificationUrl = directNotificationUrl[0];
    const configName = headers[exports.DIRECT_CONFIG_HEADERNAME];
    const directRoutingConfig = options.directRoutingConfig || {};
    if (configName) {
      const config = directRoutingConfig[configName[0]];
      result.directNotificationHeaders = config.headers || {};
      result.directNotificationAuth = config.auth || {};
    }
  }
  return result;
};

exports.getDirectPostRequestRouting = function(request, options) {
  const headers = options.headers || {};
  const result = {};
  const headername = exports.DIRECT_POST_URL_HEADERNAME;
  if (headername) {
    const headerValue = headers[headername];
    if (headerValue) {
      result.url = headerValue[0];
    }
    const directRoutingConfig = options.directRoutingConfig || {};
    const configName = headers[exports.DIRECT_CONFIG_HEADERNAME];
    if (configName) {
      const config = directRoutingConfig[configName[0]];
      result.headers = config.headers || {};
      result.auth = config.auth || {};
    }
  }
  if (request) {
    return merge(true, request, result);
  }
  return result;
};

exports.headersToObject = function(headers) {
  const headerList = headers.getList();
  const result = {};
  for (const header of headerList) {
    if (!Object.prototype.hasOwnProperty.call(result, header.key)) {
      result[header.key] = headers.getDecoded(header.key).map(h => h.value);
    }
  }
  return result;
};

exports.toJson64 = function(data) {
  const json = JSON.stringify(data);
  return Base64.encode(json);
};

exports.fromJson64 = function(data) {
  const decoded = JSON.parse(data);
  return JSON.parse(decoded);
};

exports.addressToObject = function(address) {
  const result = {
    'original': address.original.toLowerCase(),
    'host': address.host.toLowerCase(),
    'user': address.user.toLowerCase()
  };
  if (address.original_host) {
    result['original_host'] = address.original_host.toLowerCase();
  }
  return result;
};

const extractAddress = function(source) {
  if (typeof source === 'string') {
    source = addressParser(source);
  }

  if (Array.isArray(source)) {
    if (source.length < 1) {
      return;
    }
    source = source[0];
  }

  if (typeof source === 'object' && source !== null) {
    return source.address || source.value;
  }

  if (typeof source === 'string' && source) {
    return source;
  }
};

exports.adjustEnvelope = function(envelope) {
  const headers = exports.headersToObject(envelope.headers);
  let from = extractAddress(headers['from']);
  const replyTo = extractAddress(headers['replyToHeader']);
  if (!extractAddress(envelope.from)) {
    if (!from) {
      return {
        error: new Error('Missing \'from\' field in envelope')
      };
    }
    envelope.from = from;
  }
  if (!from) {
    from = envelope.from;
    envelope.headers.remove('from');
    envelope.headers.add('from', from);
  }
  if (!replyTo) {
    envelope.headers.remove('reply-to');
    envelope.headers.add('reply-to', from);
  }

  return {};
};

exports.envelopeToTransport = function(envelope) {
  const toString = Array.isArray(envelope.to) ?
    envelope.to.join(',') : envelope.to;
  const to = addressParser(toString).map(
    a => exports.addressToObject(new Address(a.address))
  );
  let from = '';
  const fromParsed = addressParser(envelope.from);
  if (Array.isArray(fromParsed) && fromParsed.length > 0) {
    from = exports.addressToObject(new Address(
      fromParsed[0].address
    ));
  }
  return {
    ...envelope,
    'mail_from': from,
    'rcpt_to': to,
    headers: exports.headersToObject(envelope.headers)
  };
};

exports.transportLogInfo = function(transport) {
  if (!transport) {
    return '';
  }

  const toAddressObjects = transport.target ?
    [transport.target] : (transport.rcpt_to || []);
  const toAddresses = toAddressObjects.map(a=>a.original).join(',');
  const to = `to: [${toAddresses}]`;
  const from = transport.mail_from ?
    ` from: ${transport.mail_from.original}` : '';
  let id = '';
  if (transport.headers && transport.headers['message-id']) {
    id = ` id: ${transport.headers['message-id'][0]}`;
  }

  return `${to}${from}${id}`;
};
