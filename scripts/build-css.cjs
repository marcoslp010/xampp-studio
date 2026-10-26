const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const utilitiesPath = path.join(root, '.tailwind.tmp.css');
const sourcePath = path.join(root, 'src', 'styles.css');
const outputPath = path.join(root, 'styles.css');

try {
  const utilities = fs.readFileSync(utilitiesPath, 'utf8');
  const manifest = fs.readFileSync(sourcePath, 'utf8');
  const source = manifest.replace(/@import "(\.\/styles\/[\w-]+\.css)";/g, (_, relativePath) => {
    const modulePath = path.resolve(path.dirname(sourcePath), relativePath);
    return fs.readFileSync(modulePath, 'utf8');
  });
  if (/@import\b/.test(source)) throw new Error('Unresolved CSS import in src/styles.css');
  fs.writeFileSync(outputPath, `${utilities}\n\n${source.trimEnd()}\n`, 'utf8');
} finally {
  if (fs.existsSync(utilitiesPath)) fs.unlinkSync(utilitiesPath);
}
