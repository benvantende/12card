# Changelog

## 1.0.0 (2026-11-23)

First public release. Earlier versions were numbered by date (2026-11-19 to 2026-11-23.5) while 12card was being built and tested on a real Model 12 card.

- **Listen:** 12-track player with a preview console (compressor, 3-band EQ, FX 1 and FX 2 sends, pan, mute/solo, faders), Main mix playback of 11/12, mixdowns from `MUSIC`, track overview with marks, console snapshots, mixes saved per song.
- **Effects and mastering:** the Model 12's 16 effect types (approximations), 12 mastering presets made of editable building blocks, loudness targets for downloads.
- **Track editing:** swap, copy, clear and import (WAV, FLAC, MP3, M4A, OGG, Opus; optional loudness normalising), with undo/redo.
- **Trim song:** cut the start and end of all tracks at the same sample, with Find silence; marks move with the music; undo keeps the originals until you delete them.
- **Songs:** rename, duplicate, protect, delete, and new songs from Import.
- **Song info:** title, artist, genre, year, BPM with tempo detection, description, comment, cover; stored in `SETTINGS` on the card.
- **Export:** stereo mix to `MUSIC`, byte-identical to the unit's own; FLAC downloads with tags and optional silence trim.
- **Check card:** reads every byte, finds read-only files, missing tracks and leftovers.
- Works from a double-clicked `index.html` (Linux, Mac, Windows) or installed as an app from `serve.sh` or any web host.
