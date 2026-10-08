// Playwright runs this function in every newly-created/navigated document.
// Seed only the fixture's HTTP origin, never the initial opaque about:blank page.
// Do not catch storage failures on the real fixture origin: those must fail CI.
export function seedFixtureStorage({origin, values, denyStorage}) {
  if (window.location.origin !== origin) return;
  if (denyStorage) {
    Object.defineProperty(window, 'localStorage', {
      get() { throw new DOMException('blocked', 'SecurityError'); },
    });
    return;
  }
  for (const [key, value] of Object.entries(values)) {
    if (key === 'zhixue:onboarding:login:v1') {
      window.sessionStorage.setItem(key, JSON.stringify({progress: JSON.parse(value), at: Date.now()}));
    } else {
      window.localStorage.setItem(key, value);
    }
  }
}
