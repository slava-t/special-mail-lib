const fs = require('fs');
const path = require('path');
const yaml = require('yaml');

module.exports = function(configPath = '/moment/env/env.yaml') {
  const resolvedPath = path.resolve(__dirname, configPath);
  return yaml.parse(fs.readFileSync(resolvedPath, 'utf8'));
};

