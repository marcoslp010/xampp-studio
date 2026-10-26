'use strict';
const fs = require('node:fs');
const path = require('node:path');

function listExtensionDownloads(directory, phpRoot, findJob = () => null) {
  if (!fs.existsSync(directory)) return [];
  const downloads = [];
  const key = root => path.resolve(root).toLowerCase();
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/.test(entry.name)) continue;
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(directory, entry.name, 'manifest.json'), 'utf8'));
      // Older downloads recorded the target in the job payload, before manifests included it.
      const root = manifest.phpRoot || findJob(entry.name)?.payload?.phpRoot;
      if (typeof root !== 'string' || key(root) !== key(phpRoot)) continue;
      if (!/^php_[a-z0-9_-]+\.dll$/i.test(manifest.dll) || !/^[a-z0-9_.-]+\.zip$/i.test(manifest.build)) continue;
      if (![manifest.dll, manifest.build].every(file => fs.existsSync(path.join(directory, entry.name, file)))) continue;
      downloads.push({ ...manifest, phpRoot: root, downloadUrl: `/api/extensions/downloads/${entry.name}/${manifest.dll}`, archiveUrl: `/api/extensions/downloads/${entry.name}/${manifest.build}` });
    } catch { /* Incomplete or unrelated downloads are not assigned to a runtime. */ }
  }
  return downloads.sort((a, b) => String(b.downloadedAt || '').localeCompare(String(a.downloadedAt || '')));
}

module.exports = { listExtensionDownloads };
