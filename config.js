import fs from 'fs';
import path from 'path';
import yaml from 'yaml';

export default function(configPath = '/moment/env/env.yaml') {
  const resolvedPath = path.resolve(__dirname, configPath);
  return yaml.parse(fs.readFileSync(resolvedPath, 'utf8'));
}

