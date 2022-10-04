import streamBuffers from 'stream-buffers';

const sendEmailCallBack = function(plugin, resolve, reject) {
  return function(code, msg) {
    switch (code) {
      case plugin.DENY:
        return reject(new Error(`Queueing outbound mail failed: ${msg}`));
      case plugin.OK:
        return resolve();
    }
    return reject(new Error(
      `Unrecognized return code from sending email: ${msg}`
    ));
  };
};

// eslint-disable-next-line camelcase
exports.send_email = function(plugin, from, to, eml64, options = {}) {
  return new Promise(function(resolve, reject) {
    const emailStream = new streamBuffers.ReadableStreamBuffer({
      frequency: 10,
      chunkSize: 64 * 1024
    });
    emailStream.put(Buffer.from(eml64, 'base64'));
    emailStream.stop();
    plugin.outbound.send_email(
      from,
      to,
      emailStream,
      sendEmailCallBack(plugin, resolve, reject),
      options
    );
  });
};

// eslint-disable-next-line camelcase
exports.bounce_email = function(plugin, from, to, headers, eml64, dsn) {
  const options = {
    notes: {
      bounce: {
        dsn,
        from,
        to,
        headers
      }
    }
  };
  return exports.send_email(plugin, from, to, eml64, options);
};

