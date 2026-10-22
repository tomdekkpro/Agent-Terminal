export const isMac = /Mac/i.test(navigator.platform || navigator.userAgent);
/** The platform's command modifier: Cmd on mac, Ctrl elsewhere */
export const isModKey = (e: { metaKey: boolean; ctrlKey: boolean }) => (isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey);
export const modLabel = isMac ? '⌘' : 'Ctrl+';
