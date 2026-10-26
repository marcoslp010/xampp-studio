const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const utilitiesPath = path.join(root, '.tailwind.tmp.css');
const sourcePath = path.join(root, 'src', 'styles.css');
const outputPath = path.join(root, 'styles.css');

try {
  const utilities = fs.readFileSync(utilitiesPath, 'utf8');
  const source = fs.readFileSync(sourcePath, 'utf8');
  fs.writeFileSync(outputPath, `${utilities}\n\n${source}`, 'utf8');
} finally {
  if (fs.existsSync(utilitiesPath)) fs.unlinkSync(utilitiesPath);
}
