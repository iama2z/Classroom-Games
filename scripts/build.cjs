const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'Code.gs'), 'utf8');
const index = path.join(root, 'index.html');
const html = fs.readFileSync(index, 'utf8').replace(
  /(<textarea id="gasCodeTextarea"[^>]*>)[\s\S]*?(<\/textarea>)/,
  (_, start, end) => start + '\n' + source + end
);
fs.writeFileSync(index, html);
fs.writeFileSync(path.join(root, 'chameleon_deduction_classroom_game.html'), html);
fs.mkdirSync(path.join(root, 'vendor'), { recursive: true });
fs.copyFileSync(require.resolve('qrcode-generator'), path.join(root, 'vendor/qrcode.js'));
