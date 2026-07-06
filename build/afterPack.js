const path = require('path');
const fs = require('fs');
const { rcedit } = require('rcedit');

module.exports = async function(context) {
  // Try project-root assets/ first, fall back to src/assets/
  let iconPath = path.resolve(__dirname, '..', 'assets', 'icon.ico');
  if (!fs.existsSync(iconPath)) {
    iconPath = path.resolve(__dirname, '..', 'src', 'assets', 'icon.ico');
  }
  if (!fs.existsSync(iconPath)) {
    console.log('[afterPack] Icon not found at', iconPath);
    return;
  }
  const appDir = context.appOutDir;
  if (fs.existsSync(appDir)) {
    const exeFiles = fs.readdirSync(appDir).filter(f => f.endsWith('.exe'));
    for (const exe of exeFiles) {
      const exePath = path.join(appDir, exe);
      try {
        await rcedit(exePath, { icon: iconPath });
        console.log(`[afterPack] Icon applied: ${exe}`);
      } catch (err) {
        console.error(`[afterPack] Failed: ${err.message}`);
      }
    }
  }
};
