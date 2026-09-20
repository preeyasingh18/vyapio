# Video assets

`AmbientLoop` reads from this directory. Every file here is **optional**: when a
video is missing, unplayable, or the visitor prefers reduced motion, the
component keeps its poster image on screen. Nothing breaks, and no layout
shifts.

## Expected files

| File                   | Used by      | Poster                       |
| ---------------------- | ------------ | ---------------------------- |
| `shop-loop.mp4`        | Landing hero | `/images/shop-poster.svg`    |

## Specification

A 5–8 second silent loop of a neighbourhood shop: the shopkeeper behind the
counter, a customer arriving, a phone held up to scan, a word spoken, a hand
reaching to a shelf. It should look like a real shop on a real evening, not
stock footage of an office.

Encode for a mid-range Android phone on a slow connection:

```bash
ffmpeg -i source.mov \
  -t 8 -an \
  -vf "scale=-2:1080,fps=30" \
  -c:v libx264 -profile:v main -crf 26 -preset slow \
  -movflags +faststart \
  shop-loop.mp4
```

- **No audio track** — it is muted anyway, and the track is wasted bytes.
- `-movflags +faststart` puts the index first so playback can begin while
  downloading.
- Target under 2 MB. If it is larger, shorten the loop before lowering quality.
- Cut on a matching frame so the loop point is invisible.

## Posters

The committed poster is an SVG, which keeps the repository light and renders
crisply at any size. If you replace a video, export a matching poster from its
first frame:

```bash
ffmpeg -i shop-loop.mp4 -frames:v 1 -q:v 3 ../images/shop-poster.jpg
```

Then point the `poster` prop at the new file.
