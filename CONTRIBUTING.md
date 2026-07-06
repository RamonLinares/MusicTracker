# Contributing

Thanks for taking the time to improve WebTracker.

## Local Setup

WebTracker is a static HTML/CSS/JavaScript app. It has no install step and no
runtime package manager dependencies.

```sh
python3 -m http.server 8642
```

Open <http://localhost:8642> after starting the server.

Do not test by opening `index.html` directly from the filesystem. The app uses
AudioWorklet, which must be loaded from an HTTP origin.

The repository also provides convenience scripts:

```sh
npm run serve
npm test
```

## Before Opening a Pull Request

- Run the app from a local static server.
- Verify playback starts after a user interaction.
- Run `npm test`.
- Verify loading and saving a small MOD file still works when touching parser,
  writer, or playback code.
- Check browser console output for new errors.
- Keep exported `.mod` files, `.MOD` files, and local tooling folders such as
  `.claude/` out of the commit.

## Code Style

- Keep the app dependency-free unless a new dependency clearly pays for itself.
- Prefer small, focused changes over broad refactors.
- Keep browser compatibility in mind for Web Audio, AudioWorklet, Canvas, and
  file APIs.
- Use clear names and short comments only where the behavior is not obvious.

## Issue Reports

When reporting a bug, include:

- browser and operating system
- steps to reproduce
- whether the issue happens locally, on GitHub Pages, or both
- a small test file only if you have permission to share it publicly

Private or copyrighted music files should not be attached to public issues.
