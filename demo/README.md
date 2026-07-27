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

Then render. The GIF uses [agg](https://github.com/asciinema/agg):

```bash
agg --theme monokai --font-size 16 --last-frame-duration 1 demo/prodgate.cast demo/prodgate.gif
```

The SVG uses [svg-term-cli](https://github.com/marionebl/svg-term-cli):

```bash
npx svg-term-cli --in demo/prodgate.cast --out demo/prodgate.svg --window --width 92 --height 22
```
