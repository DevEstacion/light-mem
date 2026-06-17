#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const packageJsonPath = path.join(rootDir, 'package.json');
const claudePluginPath = path.join(rootDir, '.claude-plugin', 'plugin.json');
const bundledClaudePluginPath = path.join(rootDir, 'plugin', '.claude-plugin', 'plugin.json');
const marketplacePath = path.join(rootDir, '.claude-plugin', 'marketplace.json');
const bundledPackageJsonPath = path.join(rootDir, 'plugin', 'package.json');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n');
}

function syncClaudePlugin(plugin, pkg) {
  return {
    ...plugin,
    name: pkg.name,
    version: pkg.version,
    description: pkg.description,
    homepage: pkg.homepage,
    repository: normalizeRepositoryUrl(pkg.repository),
    license: pkg.license,
    keywords: pkg.keywords,
    author: {
      ...(typeof plugin.author === 'object' && plugin.author ? plugin.author : {}),
      name: normalizeAuthorName(pkg.author),
    },
  };
}

function normalizeAuthorName(author) {
  if (typeof author === 'string') return author;
  if (author && typeof author === 'object' && typeof author.name === 'string') return author.name;
  return '';
}

function normalizeRepositoryUrl(repository) {
  if (typeof repository === 'string') return repository.replace(/\.git$/, '');
  if (repository && typeof repository === 'object' && typeof repository.url === 'string')
    return repository.url.replace(/\.git$/, '');
  return '';
}

// Sync each plugin entry in marketplace.json to package.json's version +
// description. The marketplace catalog version is what Claude Code reports as
// the installed plugin version; if it drifts from the worker's own version
// (read from plugin/package.json) the worker recycles itself on every hook.
function syncMarketplace(marketplace, pkg) {
  return {
    ...marketplace,
    plugins: (marketplace.plugins || []).map((plugin) => ({
      ...plugin,
      version: pkg.version,
      description: pkg.description,
    })),
  };
}

function main() {
  for (const filePath of [
    packageJsonPath,
    claudePluginPath,
    bundledClaudePluginPath,
    marketplacePath,
    bundledPackageJsonPath,
  ]) {
    if (!fs.existsSync(filePath)) {
      console.error(`Missing required file: ${filePath}`);
      process.exit(1);
    }
  }

  const pkg = readJson(packageJsonPath);
  const claudePlugin = readJson(claudePluginPath);
  const bundledClaudePlugin = readJson(bundledClaudePluginPath);
  const marketplace = readJson(marketplacePath);
  const bundledPackageJson = readJson(bundledPackageJsonPath);

  writeJson(claudePluginPath, syncClaudePlugin(claudePlugin, pkg));
  writeJson(bundledClaudePluginPath, syncClaudePlugin(bundledClaudePlugin, pkg));
  writeJson(marketplacePath, syncMarketplace(marketplace, pkg));
  // plugin/package.json keeps its own name/description (runtime dep manifest);
  // only the version is derived from the root package.json.
  writeJson(bundledPackageJsonPath, { ...bundledPackageJson, version: pkg.version });

  console.log('✓ Synced plugin manifests + marketplace from package.json');
}

main();
