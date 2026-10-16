import { execFileSync } from 'child_process';
import { homedir } from 'os';
import { join } from 'path';

/** macOS/Linux apps launched from Finder/Dock inherit a bare
 *  PATH=/usr/bin:/bin:/usr/sbin:/sbin, so spawn('claude' | 'gh' | 'npm')
 *  fails with ENOENT / "command not found" even though the same command works
 *  in the user's terminal. Ask the user's login+interactive shell for its PATH
 *  (that loads .zprofile/.zshrc, i.e. Homebrew and nvm) and adopt it for the
 *  whole main process, then append the usual install dirs as a fallback.
 *  Must run before anything spawns a child process. No-op on Windows. */
export function loadShellPath(): void {
  if (process.platform === 'win32') return;

  const marker = '__AGENT_TERMINAL_PATH__';
  try {
    const out = execFileSync(
      process.env.SHELL || '/bin/zsh',
      ['-ilc', `printf '${marker}%s${marker}' "$PATH"`],
      {
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'ignore'],
        // Keep oh-my-zsh & co from running their update prompts
        env: { ...process.env, DISABLE_AUTO_UPDATE: 'true', ZSH_DISABLE_COMPFIX: 'true' },
      },
    );
    const match = out.match(new RegExp(`${marker}(.*)${marker}`));
    if (match?.[1]) process.env.PATH = match[1];
  } catch {
    // Shell timed out or failed — fall through to the static dirs below
  }

  const home = homedir();
  const current = (process.env.PATH || '').split(':').filter(Boolean);
  const extra = [
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    join(home, '.local', 'bin'),
    join(home, '.claude', 'local'),
    join(home, '.npm-global', 'bin'),
    join(home, '.volta', 'bin'),
    join(home, '.bun', 'bin'),
  ];
  for (const dir of extra) {
    if (!current.includes(dir)) current.push(dir);
  }
  process.env.PATH = current.join(':');

  // Finder launches also have no locale, which turns æ/ø/å into <00e6> in zsh
  if (!process.env.LANG && !process.env.LC_ALL) process.env.LANG = 'en_US.UTF-8';
}
