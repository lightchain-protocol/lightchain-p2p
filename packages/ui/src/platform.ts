/**
 * What genuinely differs per operating system.
 *
 * The brand does not change between platforms; conventions do. An application
 * where the settings shortcut is Ctrl+, on macOS, or where the window controls
 * sit on the wrong side, reads as foreign no matter how correct the colours are.
 *
 * Keeping this in one place means the rest of the interface can be written once
 * without scattering `if (mac)` through the view layer.
 */

export type Platform = 'win32' | 'darwin' | 'linux'

export interface PlatformConventions {
  readonly platform: Platform
  /** Where the close/minimise/maximise controls sit. */
  readonly windowControls: 'left' | 'right'
  /** The primary modifier, for display in menus and hints. */
  readonly modifier: 'Cmd' | 'Ctrl'
  /** Accelerator prefix as Electron expects it. */
  readonly accelerator: 'CommandOrControl'
  /** Whether the app owns a menu bar that lives outside the window. */
  readonly globalMenuBar: boolean
  /**
   * Whether a titlebar is drawn by the OS. On macOS we inset our own content
   * behind the traffic lights; elsewhere the frame is ours to draw.
   */
  readonly titlebar: 'system' | 'custom' | 'hidden-inset'
  /** Interface font stack, so text matches everything else on the machine. */
  readonly fontStack: string
  /** Whether scrollbars overlay content rather than taking layout space. */
  readonly overlayScrollbars: boolean
  /** Conventional label for the settings surface. */
  readonly settingsLabel: 'Preferences' | 'Settings'
}

/**
 * Inter first, as Lightchain Studio sets it per platform
 * (`fork-tools/apply-source-patches.py:71-85`), with that platform's face behind
 * it only for glyphs Inter's latin subsets do not carry.
 */
const SYSTEM_FONTS: Record<Platform, string> = {
  win32: '"Inter", "Segoe WPC", "Segoe UI", sans-serif',
  darwin: '"Inter", -apple-system, BlinkMacSystemFont, sans-serif',
  linux: '"Inter", system-ui, "Ubuntu", "Droid Sans", sans-serif'
}

export function conventions(platform: Platform): PlatformConventions {
  const base = {
    platform,
    accelerator: 'CommandOrControl' as const,
    fontStack: SYSTEM_FONTS[platform]
  }

  if (platform === 'darwin') {
    return {
      ...base,
      windowControls: 'left',
      modifier: 'Cmd',
      globalMenuBar: true,
      // Content runs under the traffic lights, which is the modern Mac look and
      // still leaves them where a Mac user expects.
      titlebar: 'hidden-inset',
      overlayScrollbars: true,
      settingsLabel: 'Preferences'
    }
  }

  return {
    ...base,
    windowControls: 'right',
    modifier: 'Ctrl',
    globalMenuBar: false,
    titlebar: 'custom',
    overlayScrollbars: platform === 'win32',
    settingsLabel: 'Settings'
  }
}

/** Formats a shortcut for display, e.g. `Cmd+,` or `Ctrl+,`. */
export function shortcut(platform: Platform, key: string): string {
  return `${conventions(platform).modifier}+${key}`
}
