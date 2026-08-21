import type { HostCommand } from './ollama.js'

/**
 * The other runtime a worker cannot start without.
 *
 * Same shape as `ollama.ts` and for the same reason: a checklist that detects
 * Docker is missing and then prints a sentence about installing it has told
 * somebody what is wrong without helping. These are the two things an
 * application can honestly do about it — open the download, or ask the
 * platform to start what is already installed.
 */

export const DOCKER_DOWNLOAD_URL = 'https://www.docker.com/products/docker-desktop/'

/**
 * Starting Docker, where the platform gives us a handle on it.
 *
 * macOS only, deliberately. Docker Desktop is an application there and `open`
 * launches it. On Linux the daemon is a system service whose start needs a
 * password this application will not ask for, and on Windows the executable's
 * location is not something to guess at — both are answered with the check's
 * own remedy instead of a button that fails.
 */
export function startDocker(platform: string): HostCommand | null {
  if (platform !== 'darwin') return null
  return { file: 'open', args: ['-a', 'Docker'], display: 'open -a Docker' }
}
