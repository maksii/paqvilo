// Shared by the development CLI and generated VS Code background tasks.
export const DEV_READY = 'edit a file under the sources and the browser follows.';
export const DEV_BACKGROUND = Object.freeze({
  activeOnStart: true,
  beginsPattern: '^browser\\s+',
  endsPattern: '^edit a file under the sources and the browser follows\\.',
});

// These tasks report readiness only; CLI errors remain visible in the terminal.
export const DEV_PROBLEM_MATCHER = Object.freeze({
  owner: 'paqvilo',
  pattern: { regexp: '^(?!)()()()$', file: 1, location: 2, message: 3 },
  background: DEV_BACKGROUND,
});
