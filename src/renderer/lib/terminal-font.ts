import { type AppSettings, DEFAULT_SETTINGS } from '../../shared/types';

/** The old default — Cascadia/Consolas only, so on a Mac it fell straight
 *  through to Courier. Saved settings still carry it verbatim. */
const LEGACY_DEFAULT_FONT_FAMILY = 'Cascadia Code, Consolas, Courier New, monospace';

/** Font family for xterm instances, from settings with the default as fallback */
export function terminalFontFamily(settings: Pick<AppSettings, 'terminalFontFamily'>): string {
  const saved = settings.terminalFontFamily?.trim();
  if (!saved || saved === LEGACY_DEFAULT_FONT_FAMILY) return DEFAULT_SETTINGS.terminalFontFamily;
  return saved;
}

/** Font size for xterm instances — an emptied settings field saves NaN/null */
export function terminalFontSize(settings: Pick<AppSettings, 'terminalFontSize'>): number {
  const size = settings.terminalFontSize;
  return Number.isFinite(size) && size >= 6 ? size : DEFAULT_SETTINGS.terminalFontSize;
}
