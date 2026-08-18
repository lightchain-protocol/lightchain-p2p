const fs = require('fs')
const path = require('path')
const plink = require('pear-link')

const pkg = require('./package.json')
const appName = pkg.productName ?? pkg.name

function getWindowsKitVersion() {
  const programFiles = process.env['PROGRAMFILES(X86)'] || process.env.PROGRAMFILES
  if (!programFiles) return undefined
  const kitsDir = path.join(programFiles, 'Windows Kits')
  try {
    for (const kit of fs.readdirSync(kitsDir).sort().reverse()) {
      const binDir = path.join(kitsDir, kit, 'bin')
      if (!fs.existsSync(binDir)) continue
      const version = fs
        .readdirSync(binDir)
        .filter((d) => /^\d+\.\d+\.\d+\.\d+$/.test(d))
        .sort()
        .pop()
      if (version) return version
    }
  } catch {
    return undefined
  }
}

let packagerConfig = {
  icon: 'build/icon',
  protocols: [{ name: appName, schemes: [pkg.name] }],
  derefSymlinks: true
}

if (process.env.MAC_CODESIGN_IDENTITY) {
  packagerConfig = {
    ...packagerConfig,
    osxSign: {
      identity: process.env.MAC_CODESIGN_IDENTITY,
      optionsForFile: () => ({
        entitlements: path.join(__dirname, 'build', 'entitlements.mac.plist')
      })
    },
    osxNotarize: {
      tool: 'notarytool',
      keychainProfile: process.env.KEYCHAIN_PROFILE
    }
  }
}

module.exports = {
  packagerConfig,

  makers: [
    {
      name: '@electron-forge/maker-dmg',
      platforms: ['darwin'],
      config: {}
    },
    {
      name: '@electron-forge/maker-msix',
      platforms: ['win32'],
      config: {
        appManifest: path.join(__dirname, 'build', 'AppxManifest.xml'),
        windowsKitVersion: getWindowsKitVersion(),
        ...(process.env.WINDOWS_SIGN_HOOK
          ? {
              windowsSignOptions: {
                hookModulePath: process.env.WINDOWS_SIGN_HOOK
              }
            }
          : {})
      }
    },
    {
      name: 'pear-electron-forge-maker-appimage',
      platforms: ['linux'],
      config: {
        icons: [
          { file: 'build/icon/icon-16x16.png', size: 16 },
          { file: 'build/icon/icon-32x32.png', size: 32 },
          { file: 'build/icon/icon-64x64.png', size: 64 },
          { file: 'build/icon/icon-128x128.png', size: 128 },
          { file: 'build/icon/icon-256x256.png', size: 256 }
        ]
      }
    },
    // Flatpak and Snap are configured but not decided: neither can receive
    // peer-to-peer updates, so shipping through them means an application that
    // silently stops updating itself. See the open decisions in ROADMAP.md.
    {
      name: 'pear-electron-forge-maker-flatpak',
      platforms: ['linux'],
      config: {
        appId: 'ai.lightchain.Hub',
        icon: `${packagerConfig.icon}.png`,
        comment: pkg.description,
        categories: ['Network', 'Chat']
      }
    },
    {
      name: 'pear-electron-forge-maker-snap',
      platforms: ['linux'],
      config: {
        icon: `${packagerConfig.icon}.png`,
        snapcraft: {
          summary: pkg.description,
          description:
            'Peer-to-peer rooms between people, and paid inference from models on the Lightchain network. Keys stay on your machine.',
          contact: 'https://github.com/lightchain-protocol/lightchain-p2p/issues',
          license: 'MIT',
          issues: 'https://github.com/lightchain-protocol/lightchain-p2p/issues',
          website: 'https://lightchain.ai',
          app: {
            extensions: ['gnome'],
            plugs: [
              'desktop',
              'desktop-legacy',
              'home',
              'x11',
              'wayland',
              'audio-playback',
              'audio-record',
              'camera',
              'opengl',
              'network',
              'network-bind',
              'browser-support',
              'network-status'
            ],
            environment: {
              TMPDIR: '$XDG_RUNTIME_DIR'
            }
          },
          part: {
            'stage-packages': ['libatomic1']
          }
        }
      }
    }
  ],

  hooks: {
    readPackageJson: async (forgeConfig, packageJson) => {
      if (process.env.UPGRADE_KEY) {
        packageJson.upgrade = process.env.UPGRADE_KEY
      }

      try {
        plink.parse(packageJson.upgrade)
      } catch {
        throw new Error('Use `pear touch` to get a valid upgrade key for package.json#upgrade')
      }

      return packageJson
    },
    preMake: async () => {
      fs.rmSync(path.join(__dirname, 'out', 'make'), { recursive: true, force: true })

      const manifest = path.join(__dirname, 'build', 'AppxManifest.xml')
      const msixVersion = pkg.version.replace(/^(\d+\.\d+\.\d+)$/, '$1.0')
      const xml = fs.readFileSync(manifest, 'utf-8')
      fs.writeFileSync(manifest, xml.replace(/Version="[^"]*"/, `Version="${msixVersion}"`))
    },
    postMake: async (forgeConfig, results) => {
      for (const result of results) {
        if (result.platform !== 'win32') continue
        for (const artifact of result.artifacts) {
          if (!artifact.endsWith('.msix')) continue
          const standardDir = path.join(__dirname, 'out', `${appName}-win32-${result.arch}`)
          fs.mkdirSync(standardDir, { recursive: true })
          const dest = path.join(standardDir, path.basename(artifact))
          fs.renameSync(artifact, dest)
          fs.mkdirSync(path.dirname(artifact), { recursive: true })
          fs.copyFileSync(dest, artifact)
          result.artifacts[result.artifacts.indexOf(artifact)] = dest
        }
      }
    }
  },

  plugins: [
    {
      name: 'electron-forge-plugin-universal-prebuilds',
      config: {}
    },
    {
      name: 'electron-forge-plugin-prune-prebuilds',
      config: {}
    }
  ]
}
