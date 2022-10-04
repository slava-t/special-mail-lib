//import crypto from 'crypto'
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
const streamBuffers = require('stream-buffers');

const EnvironmentResolver = require('./EnvironmentResolver');
const DomainNameResolver = require('./DomainNameResolver');
const {getLogger} = require('./logger.js');

const asyncReadFile = util.promisify(fs.readFile);

const logger = getLogger();

const DIRECT_CONFIG_HEADERNAME = 'x-debuggex-direct-routing-config';
const DIRECT_POST_URL_HEADERNAME = 'x-debuggex-direct-routing-post-url';
const DIRECT_NOTIFY_URL_HEADERNAME = 'x-debuggex-direct-routing-notify-url';
const DIRECT_DYNAMIC_ROUTING_URL_HEADERNAME =
  'x-debuggex-direct-dynamic-routing-url';
const JSON64_DIRECT_MX = 'x-debuggex-json64-direct-mx';
const JSON64_DATA_HEADERNAME = 'x-postboy-json64-data';
const MOMENT_POST_URL_HEADERNAME = 'x-momentcrm-mail-post-to-url';
const MOMENT_NOTIFY_URL_HEADERNAME = 'x-momentcrm-notification-post-to-url';
const MOMENT_ROUTING_RESPONSE_HEADERNAME =
  'x-momentcrm-mail-routing-response';
const GUID_HEADERNAME = 'x-debuggex-guid';

const specialHeaders = [
  DIRECT_CONFIG_HEADERNAME,
  DIRECT_POST_URL_HEADERNAME,
  DIRECT_NOTIFY_URL_HEADERNAME,
  DIRECT_DYNAMIC_ROUTING_URL_HEADERNAME,
  JSON64_DATA_HEADERNAME,
  MOMENT_POST_URL_HEADERNAME,
  MOMENT_NOTIFY_URL_HEADERNAME,
  MOMENT_ROUTING_RESPONSE_HEADERNAME
];

const routingHeaders = [
  ...specialHeaders,
  GUID_HEADERNAME
];

const normalizeEOLs = function(str, keepSingleCR = true) {
  if (str && typeof str === 'string') {
    const crReplacement = keepSingleCR ? '\n' : '';
    return str.replace(/\r?\n/g, '\n').replace(/\r/g, crReplacement)
        .replace(/\n/g, '\r\n');
  }
  return str;
};

const specialHeadersSet = new Set(specialHeaders);

const asyncWrapper = function(func) {
  return function(req, res, next) {
    Promise.resolve(func(req, res, next)).catch(next);
  };
};

const clearInboxes = async function(inboxes) {
  let errors = 0;
  while (inboxes.length) {
    const inbox = inboxes.pop();
    try {
      await inbox.clear();
    } catch (err) {
      logger.error(err);
    }
  }
  if (errors) {
    errors = 0;
    throw new Error('There are errors during inboxes cleanup.');
  }
};

const randomHexString = function(len) {
  return crypto.randomBytes(len).toString('hex').substr(0, len);
};

const randomAlphanumeric = function(
  len = 24,
  randomFunc = crypto.randomBytes
) {
  const result = randomFunc(len).toString('base64')
      .replace(/[/+]/g, '').substr(0, len);
  if (result.length === len) {
    return result;
  }
  return randomAlphanumeric(len, randomFunc);
};

const errorHandler = function(err, req, res, next) {
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

const ok = function(res, result) {
  res.status(200).send({success: true, result});
};

const hashQueueName = function(base, index) {
  return base + crypto.createHash('md5').update(
    index.toString()
  ).digest('hex')[0];
};

const parseRoutingConfig = function(data) {
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


const getDomainHashKey = function(domain, len = 2) {
  const normalizedDomain = domain.toLowerCase().replace(/\./g, ' ').trim();
  const hash = crypto.createHash('sha256').update(
    normalizedDomain
  ).digest('hex');
  return hash.substr(0, len).toLowerCase();
};

const getDkimDir = function(configDir, domain, defaultDkim = false) {
  const folderName = defaultDkim ?
    'default' : getDomainHashKey(domain, 2);
  return path.join(configDir, 'dkim', folderName);
};

const getDkim = async function(dir, domain, config, defaultDkim = false) {
  const dkimDir = getDkimDir(dir, domain, defaultDkim);
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

let nonce = 0;
const saveEmail = function(baseDir, eml, transport, moreData = {}) {
  try {
    const toDir = transport['rcpt_to'].map(a => a.host).join('_') ||
      'invalid';
    const fromDir = transport['mail_from'].host || 'bounced';
    const now = new Date().toISOString();
    const dateDir = now.substr(0, 10);
    const baseFileName = now.substr(11).replace(/:/g, '_') + '-' + ++nonce;
    const targetDir = path.join(
      baseDir,
      dateDir,
      fromDir,
      toDir
    );
    fs.mkdirSync(targetDir, {recursive: true});

    const jsonPath = path.join(targetDir, baseFileName + '.json');
    const emlPath = path.join(targetDir, baseFileName + '.eml');
    const jsonData = {
      ...moreData,
      //dkimDir: delivery.dkimDir,
      transport
    };
    fs.writeFileSync(
      jsonPath,
      JSON.stringify(jsonData, null, 2)
    );
    if (eml) {
      fs.writeFileSync(
        emlPath,
        eml
      );
    }
  } catch (err) {
    logger.error('Fail to save email.', err);
  }
};

const dnsResolve = function(hostname, recordType, timeout = 20000) {
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
const allPromises = function(promises) {
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

const copyStream = function(source, dest) {
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

const streamToBuffer = async function(source) {
  const streamBuffer = new streamBuffers.WritableStreamBuffer({
    initialSize: (64 * 1024),
    incrementAmount: (64 * 1024)
  });
  await copyStream(source, streamBuffer);
  return streamBuffer.getContents();
};

const streamToBase64 = async function(source) {
  const buffer = await streamToBuffer(source);
  return buffer.toString('base64');
};

const bufferToStream = async function(buffer, dest) {
  const streamBuffer = new streamBuffers.ReadableStreamBuffer({
    frequency: 10,
    chunkSize: 64 * 1024
  });
  const copyPromise = copyStream(streamBuffer, dest);
  streamBuffer.put(buffer);
  streamBuffer.stop();
  await copyPromise;
};

const getMailServers = function(routingConfig) {
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

const getEnvironment = function(targetDomain, options) {
  const envResult = options.environmentResolver.resolve(targetDomain);

  if (envResult) {
    return options.routingConfig.environments[envResult.env];
  }
};

const createResolvers = function(configDir) {
  const resolverConfig = yaml.parse(
    fs.readFileSync(path.join(configDir, 'domain-resolver.yaml'), 'utf8')
  );
  const resolver = new DomainNameResolver(resolverConfig);

  const routingConfig = parseRoutingConfig(yaml.parse(
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


const getDirectNotifyRequestRouting = function(options = {}) {
  const headers = options.headers || {};

  const result = {};
  const directNotificationUrl = headers[DIRECT_NOTIFY_URL_HEADERNAME];
  if (directNotificationUrl) {
    result.directNotificationUrl = directNotificationUrl[0];
    const configName = headers[DIRECT_CONFIG_HEADERNAME];
    const directRoutingConfig = options.directRoutingConfig || {};
    if (configName) {
      const config = directRoutingConfig[configName[0]];
      result.directNotificationHeaders = config.headers || {};
      result.directNotificationAuth = config.auth || {};
    }
  }
  return result;
};

const getDirectPostRequestRouting = function(request, options) {
  const headers = options.headers || {};
  const result = {};
  const headername = DIRECT_POST_URL_HEADERNAME;
  if (headername) {
    const headerValue = headers[headername];
    if (headerValue) {
      result.url = headerValue[0];
    }
    const directRoutingConfig = options.directRoutingConfig || {};
    const configName = headers[DIRECT_CONFIG_HEADERNAME];
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

const headersToObject = function(headers) {
  const headerList = headers.getList();
  const result = {};
  for (const header of headerList) {
    if (!Object.prototype.hasOwnProperty.call(result, header.key)) {
      result[header.key] = headers.getDecoded(header.key).map(h => h.value);
    }
  }
  return result;
};

const hasSpecialHeaders = function(mail) {
  const headers = mail.headers || [];
  for (const header of headers) {
    const headername = header[0];
    if (specialHeadersSet.has(headername.toLowerCase())) {
      return true;
    }
  }
  return false;
};

const copyRoutingHeaders = function(source, destination) {
  for (const routingHeader of routingHeaders) {
    const value = source[routingHeader];
    if (value) {
      destination.update(routingHeader, value[0]);
    }
  }
};

const toJson64 = function(data) {
  const json = JSON.stringify(data);
  return Base64.encode(json);
};

const fromJson64 = function(data) {
  const decoded = Base64.decode(data);
  return JSON.parse(decoded);
};

const addressToObject = function(address) {
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
  if (Array.isArray(source)) {
    if (source.length < 1) {
      return;
    }
    source = source[0];
  }

  if (typeof source === 'string') {
    source = addressParser(source);
    if (Array.isArray(source)) {
      if (source.length < 1) {
        return;
      }
      source = source[0];
    }
  }

  if (typeof source === 'object' && source !== null) {
    return source.address || source.value;
  }

  if (typeof source === 'string' && source) {
    return source;
  }
};

const getMxFromHeaders = function(headers) {
  const mxHeader = headers[JSON64_DIRECT_MX];
  if (mxHeader) {
    return fromJson64(mxHeader[0]);
  }
};

const adjustEnvelope = function(envelope) {
  if (envelope.interface === 'bounce') {
    return {};
  }
  const headers = headersToObject(envelope.headers);
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

const envelopeToTransport = function(envelope) {
  const toString = Array.isArray(envelope.to) ?
    envelope.to.join(',') : envelope.to;
  const to = addressParser(toString).map(
    a => addressToObject(new Address(a.address))
  );
  let from = '';
  const fromParsed = addressParser(envelope.from);
  if (Array.isArray(fromParsed) && fromParsed.length > 0) {
    from = addressToObject(new Address(
      fromParsed[0].address
    ));
  }
  return {
    ...envelope,
    'mail_from': from,
    'rcpt_to': to,
    headers: headersToObject(envelope.headers)
  };
};

const extractGuidFromHeaders = function(headers) {
  if (!headers) {
    return;
  }
  const guidHeader = headers[GUID_HEADERNAME];
  if (guidHeader) {
    if (Array.isArray(guidHeader) && guidHeader.length == 1) {
      return guidHeader[0];
    } else if (typeof guidHeader === 'string') {
      return guidHeader;
    }
  }
};

const extractGuid = function(content, fromHeaders = true) {
  if (!content) {
    return;
  }

  if (content.guid) {
    return content.guid;
  }

  const transport = content.transport;
  if (!transport) {
    return;
  }

  if (transport.guid) {
    return transport.guid;
  }

  const target = transport.target;
  if (target && target.guid) {
    return target.guid;
  }
  if (fromHeaders) {
    return extractGuidFromHeaders(transport.headers);
  }
};

const transportLogInfo = function(transport, guidFromHeaders = true) {
  if (!transport) {
    return '';
  }

  const toAddressObjects = transport.target ?
    [transport.target] : (transport.rcpt_to || []);
  const to = toAddressObjects.map(a=>a.original).join(',');
  const from = transport.mail_from ?
    ` from: ${transport.mail_from.original}` : '';
  let id = '';
  if (transport.headers && transport.headers['message-id']) {
    id = ` id: ${transport.headers['message-id'][0]}`;
  }
  const guid = extractGuid({transport}, guidFromHeaders);
  return {
    id,
    guid,
    to,
    from
  };
};

const generateGuid = function(prefix = 'email_', len = 24) {
  const r = randomAlphanumeric(len).replace('I', 'T').replace('l', 'L');
  return prefix.toString() + r;
};

const getRelaxedHeaderLine = function(headers, headerName) {
  let headerValues = headers[headerName] || [];
  if (!Array.isArray(headerValues)) {
    headerValues = [headerValues];
  }
  const cleanHeaderValues = headerValues.map(
    x => x.replace(/\r?\n/g, '').replace(/\r?\n/g, '').trim()
  );
  return headerName.toLowerCase().trim() + ': ' +
    cleanHeaderValues.join('\r\n');
};

const generateEmailGuid = function(
  from,
  to,
  headers,
  prefix = 'email_',
  len = 24
) {
  const lines = ['from-user: ' + (from.user || '')];
  lines.push('from-host: ' + (from.host || ''));
  lines.push('to-user: ' + (to.user || ''));
  lines.push('to-host: ' + (to.host || ''));

  for (const headerName of ['message-id', 'from', 'to', 'subject']) {
    lines.push(getRelaxedHeaderLine(headers, headerName));
  }

  const buffer = Buffer.from(
    lines.join('\r\n') + '\r\n',
    'binary'
  );

  return prefix + crypto.createHash('sha512')
      .update(buffer)
      .digest('base64')
      .replace(/[/+=]/g, '')
      .replace('I', 'T')
      .replace('l', 'L')
      .substr(0, len)
      .padEnd(len, 'd');
};

const extractAddressObjects = function(source) {
  const result = [];
  if (!source) {
    return result;
  }
  if (Array.isArray(source)) {
    for (const item of source) {
      result.push(...extractAddressObjects(item));
    }
  } else if (typeof source === 'object') {
    const sourceAddress = source.address;
    if (sourceAddress &&
      (typeof sourceAddress === 'string' || sourceAddress instanceof String)
    ) {
      result.push({
        name: source.name || '',
        address: sourceAddress
      });
    } else {
      result.push(...extractAddressObjects(Object.values(source)));
    }
  }
  return result;
};

const parseAddresses = function(source) {
  let result = [];
  if (!source) {
    return result;
  } else if (Array.isArray(source)) {
    const parsedAddresses = source.map(x => parseAddresses(x));
    result = parsedAddresses.reduce((p, c) => p.concat(c), []);
  } else if (typeof source === 'object') {
    result = [{
      name: source.name,
      address: source.address
    }];
  } else {
    result = addressParser(source);
  }
  return extractAddressObjects(result);
};

const getAddressesFromEmail = function(email) {
  const from = parseAddresses(email.from);
  const to = parseAddresses(email.to);
  const cc = parseAddresses(email.cc);
  const bcc = parseAddresses(email.bcc);
  const envelope = email.envelope || {};
  const envelopeFrom = parseAddresses(envelope.from);
  const envelopeTo = parseAddresses(envelope.to);
  const envelopeCc = parseAddresses(envelope.cc);
  const envelopeBcc = parseAddresses(envelope.bcc);
  const recipients = Array.from(new Set(
    to.concat(cc, bcc, envelopeTo, envelopeCc, envelopeBcc).map(x => x.address)
  ).values());

  return {
    from,
    to,
    cc,
    bcc,
    envelopeFrom,
    envelopeTo,
    envelopeCc,
    envelopeBcc,
    recipients
  };
};



const generateMessageId = function(domain, prefix = 'id.') {
  return `<${prefix}${Date.now()}.${randomHexString(24)}@${domain}>`;
};

module.exports = {
  DIRECT_CONFIG_HEADERNAME,
  DIRECT_POST_URL_HEADERNAME,
  DIRECT_NOTIFY_URL_HEADERNAME,
  DIRECT_DYNAMIC_ROUTING_URL_HEADERNAME,
  JSON64_DIRECT_MX,
  JSON64_DATA_HEADERNAME,
  MOMENT_POST_URL_HEADERNAME,
  MOMENT_NOTIFY_URL_HEADERNAME,
  MOMENT_ROUTING_RESPONSE_HEADERNAME,
  GUID_HEADERNAME,
  normalizeEOLs,
  asyncWrapper,
  clearInboxes,
  randomHexString,
  randomAlphanumeric,
  errorHandler,
  ok,
  hashQueueName,
  parseRoutingConfig,
  getDomainHashKey,
  getDkimDir,
  getDkim,
  saveEmail,
  dnsResolve,
  allPromises,
  copyStream,
  streamToBuffer,
  streamToBase64,
  generateMessageId,
  bufferToStream,
  getMailServers,
  getEnvironment,
  createResolvers,
  getDirectNotifyRequestRouting,
  getDirectPostRequestRouting,
  headersToObject,
  hasSpecialHeaders,
  copyRoutingHeaders,
  toJson64,
  fromJson64,
  addressToObject,
  getMxFromHeaders,
  adjustEnvelope,
  envelopeToTransport,
  extractGuidFromHeaders,
  extractGuid,
  transportLogInfo,
  generateGuid,
  generateEmailGuid,
  extractAddressObjects,
  parseAddresses,
  getAddressesFromEmail
};
