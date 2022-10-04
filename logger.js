import winston from 'winston';

const defaultLogger = winston.createLogger({
  level: 'info',
  format: winston.format.simple(),
  transports: [
    new winston.transports.Console({
      level: 'info',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.simple()
      )
    })
  ]
});

const getLogger = function(options = {}) {
  return options.logger || defaultLogger;
};

export {
  getLogger
};
