// Automatic theme: local daytime (06:00 <= time < 18:00), unless the OS prefers dark.
(() => {
  const root = document.documentElement;
  const darkPreference = window.matchMedia('(prefers-color-scheme: dark)');
  let boundaryTimer;
  function refreshTheme() {
    const now = new Date(), hour = now.getHours();
    const theme = darkPreference.matches || hour < 6 || hour >= 18 ? 'dark' : 'light';
    const changed = root.dataset.theme !== theme;
    root.dataset.theme = theme;
    root.style.colorScheme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'light' ? '#e9eae8' : '#0a0a0a');
    clearTimeout(boundaryTimer);
    const boundary = new Date(now);
    if (hour < 6) boundary.setHours(6, 0, 0, 0);
    else if (hour < 18) boundary.setHours(18, 0, 0, 0);
    else { boundary.setDate(boundary.getDate() + 1); boundary.setHours(6, 0, 0, 0); }
    boundaryTimer = setTimeout(refreshTheme, Math.max(1000, boundary.getTime() - now.getTime() + 20));
    if (changed) window.dispatchEvent(new Event('cofilmthemechange'));
  }
  if (darkPreference.addEventListener) darkPreference.addEventListener('change', refreshTheme);
  else darkPreference.addListener(refreshTheme);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refreshTheme(); });
  window.addEventListener('pageshow', refreshTheme);
  // Also recover from a clock/timezone change without requiring a page reload.
  setInterval(refreshTheme, 60000);
  refreshTheme();
})();
