const fs = require('fs');
const EmailParser = require('./EmailParser.js');

const parseEmailFile = async function(emlPath, transportPath) {
  const eml = fs.readFileSync(emlPath);
  let transport = null;
  if (transportPath) {
    transport = JSON.parse(
      fs.readFileSync(transportPath, 'utf8')
    ).transport;
  }
  const parser =  new EmailParser();
  const result = await parser.parse(eml, transport);
  return result;
};

module.exports = {
  parseEmailFile
};
