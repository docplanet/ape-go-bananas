// Light or dark, or whatever the system says. The palette itself is three
// blocks in style.css; all this does is decide which one applies and remember
// the choice, because the app is used at 2am as often as at noon and the
// system setting is not always the one the person wants for it.

export type Theme = 'system' | 'light' | 'dark';

const KEY = 'ape.theme';

export function readTheme(): Theme {
  try {
    const stored = localStorage.getItem(KEY);
    return stored === 'light' || stored === 'dark' ? stored : 'system';
  } catch {
    return 'system';
  }
}

/** Puts a theme in force. `system` removes the attribute, so the media query decides. */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
  // So the webview's own furniture -- scrollbars, form controls, the caret --
  // matches the palette rather than the OS.
  root.style.colorScheme = theme === 'system' ? '' : theme;
}

export function setTheme(theme: Theme): void {
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    /* a webview with storage blocked: the choice holds for this run only */
  }
  applyTheme(theme);
}
