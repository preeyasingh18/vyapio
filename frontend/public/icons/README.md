# Icons

`mark.svg` is the Vyapio mark — Mitra's aperture, the same geometry as the
React component in `src/components/character/Mitra.tsx`. Keep the two in step.

`icon-maskable.svg` adds a filled background and the 80% safe zone Android needs
to crop the icon to whatever shape the launcher uses.

## PNG exports

The manifest uses SVG, which Chrome and Edge accept for installed PWAs. Safari
and some Android launchers still prefer PNG, so export them before shipping to
production:

```bash
# requires: npm i -g sharp-cli
sharp -i mark.svg -o icon-192.png resize 192 192
sharp -i mark.svg -o icon-512.png resize 512 512
sharp -i icon-maskable.svg -o icon-maskable.png resize 512 512
```

Then add them back to the `icons` array in `vite.config.ts`. They are not
committed because binary assets generated from a source file belong to the build,
not the repository.
