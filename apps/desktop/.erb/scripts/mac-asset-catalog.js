const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ICON_SOURCE = path.resolve(__dirname, '..', '..', 'assets', 'icon.icon');
const ICON_NAME = 'icon';
const MIN_ACTOOL_MAJOR = 26;

function actoolMajorVersion() {
  try {
    const out = execFileSync('xcrun', ['actool', '--version'], {
      encoding: 'utf8',
    });
    const match = out.match(/<key>short-bundle-version<\/key>\s*<string>(\d+)/);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

exports.default = async function macAssetCatalog(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const major = actoolMajorVersion();
  if (major === null || major < MIN_ACTOOL_MAJOR) {
    const message = `actool ${MIN_ACTOOL_MAJOR}+ (Xcode ${MIN_ACTOOL_MAJOR}) not found; skipping Liquid Glass icon catalog`;
    if (process.env.CI) {
      throw new Error(message);
    }
    console.warn(`  • ${message}`);
    return;
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'talyn-icon-'));
  try {
    execFileSync('xcrun', [
      'actool',
      ICON_SOURCE,
      '--compile',
      tmpDir,
      '--output-format',
      'human-readable-text',
      '--notices',
      '--warnings',
      '--errors',
      '--app-icon',
      ICON_NAME,
      '--include-all-app-icons',
      '--enable-on-demand-resources',
      'NO',
      '--development-region',
      'en',
      '--target-device',
      'mac',
      '--minimum-deployment-target',
      '26.0',
      '--platform',
      'macosx',
      '--output-partial-info-plist',
      path.join(tmpDir, 'partial.plist'),
    ]);

    const carPath = path.join(tmpDir, 'Assets.car');
    if (!fs.existsSync(carPath)) {
      throw new Error('actool produced no Assets.car');
    }

    const appPath = path.join(
      context.appOutDir,
      `${context.packager.appInfo.productFilename}.app`
    );
    fs.copyFileSync(
      carPath,
      path.join(appPath, 'Contents', 'Resources', 'Assets.car')
    );

    const infoPlist = path.join(appPath, 'Contents', 'Info.plist');
    try {
      execFileSync('/usr/libexec/PlistBuddy', [
        '-c',
        `Add :CFBundleIconName string ${ICON_NAME}`,
        infoPlist,
      ]);
    } catch {
      execFileSync('/usr/libexec/PlistBuddy', [
        '-c',
        `Set :CFBundleIconName ${ICON_NAME}`,
        infoPlist,
      ]);
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
};
