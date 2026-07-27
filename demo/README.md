# Demo assets

The README hero (`prodgate.gif` and `prodgate.svg`) is generated from the real CLI
output, so it never drifts from what the tool actually prints.

Files:
- `plan.json` a small, realistic plan: several benign changes plus one agent-authored
  production database delete.
- `commits.txt` commit messages carrying a Claude co-author trailer, so agent
  detection fires.
- `build-cast.mjs` runs the CLI against the plan and writes `prodgate.cast`.
- `prodgate.cast` the recorded terminal session (asciicast v2).
- `prodgate.gif` / `prodgate.svg` the rendered demo.

## Regenerate

From the repo root, with the project built (`npm run build`):

```bash
node demo/build-cast.mjs
```

Then render. The GIF uses [agg](https://github.com/asciinema/agg) with a
GitHub-dark palette so it sits well in the README:

```bash
agg --theme "161b22,c9d1d9,484f58,ff4d4f,3fb950,d29922,58a6ff,bc8cff,39c5cf,b1bac4" --font-size 16 --last-frame-duration 1 demo/prodgate.cast demo/prodgate.gif
```

The SVG uses [svg-term-cli](https://github.com/marionebl/svg-term-cli):

```bash
npx svg-term-cli --in demo/prodgate.cast --out demo/prodgate.svg --window --width 92 --height 22
```
