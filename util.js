const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const dns = require('dns');
const util = require('util');

const asyncReadFile = util.promisify(fs.readFile);

exports.asyncWrapper = function(func) {
  return function(req, res, next) {
    Promise.resolve(func(req, res, next)).catch(next);
  };
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

exports.getDkimDir = function(domain, defaultDkim = false) {
  const folderName = defaultDkim ?
    'default' : exports.getDomainHashKey(domain, 2);
  return path.join(__dirname, '../config/dkim', folderName);
};

exports.getDkim = async function(domain, config, defaultDkim = false) {
  const dir = exports.getDkimDir(domain, defaultDkim);
  const textPath = path.join(dir, 'txt');
  const id = path.basename(dir);
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
