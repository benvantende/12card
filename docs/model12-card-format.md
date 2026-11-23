# TASCAM Model 12 – SD card format notes

Reverse-engineered from Ben's card copies plus the Owner's Manual. Confirmed items are marked ✅, guesses are marked ❓. The app is called **12card** (since v2026-11-21.3; before that TASCAM Model Card Manager).
- "SD CARD" = baseline
- "SD CARD 01" = after a rename and a protect test on the unit
- "SD CARD 02" = after failed case-only renames, with TV loaded as the current song
- "SD CARD 03" = after renaming the loaded song TV → `tv 2` on the unit. This is the verified source for the restore onto the new card.

## Card layout
```
tascam_m.sys            2360 B   card-level state
SETTINGS/               app settings (v2026-11-21.1): <song>.json per song + _card_settings.json; the unit ignores it ❓ (to confirm)
metadata.txt            older app versions (v.8–v.21); converted to SETTINGS on the first save, then removed
MTR/<SONG NAME>/        one folder per song (max 100 songs per card)
    01_<NAME>_TR01.wav … 01_<NAME>_TR12.wav
    song.sys            2048 B   per-song settings
    tempTrN_A.bin       0-byte undo scratch files (safe to ignore)
MUSIC/                  stereo mix exports, e.g. <NAME>_2-MIX_01.wav (subfolders up to 2 levels); also the source for TRACK IMPORT
UTILITY/                firmware updates
```
- ✅ The song name is **not** stored in any file. It is the folder name and the WAV filename prefix.
- ✅ Song names are max **11 characters**, and upper/lowercase letters, digits, symbols and spaces are allowed (manual p.37; tested: "epistem 01", "tv 2").
- ✅ A card formatted on a computer, with only `MTR` and `MUSIC` copied onto it, works in the Model 12. The unit creates `tascam_m.sys` itself.

## Rename, as done by the unit ✅ (tested 2026-11-19)
Renaming on the device (EPISTEM_01 → `epistem 01`, not loaded; TV → `tv 2`, loaded):
- renames the folder `MTR/<old>` → `MTR/<new>`
- renames all 12 WAVs `01_<old>_TRnn.wav` → `01_<new>_TRnn.wav`
- **does not change any file contents** (song.sys, WAV `bext`/`cue`/data are byte-identical)
- does not rename the export in `MUSIC/` (e.g. `TV_2-MIX_01.wav` keeps its name)
- the `tempTr*_A.bin` files keep their names

So a computer-side rename = rename folder + 12 WAVs, nothing else.

### Renaming the current (loaded) song ✅ (SD CARD 03)
- TV was loaded and renamed to `tv 2` on the unit.
- The unit **rewrote tascam_m.sys (new date) but left 0x83C = "TV"**, a name that no longer exists on the card.
- So the unit itself doesn't keep the current-song name in step with a rename.
- **App rule:** when renaming the song named in 0x83C, also write the new name into 0x83C. The app's write is byte-identical to what the unit writes when loading a song (tested against SD CARD 01 → 02).

### Case-only renames fail on the unit ✅ (tested 2026-11-19)
- TV → `tv` and WANDERING → `wANDERING` both give **"File Error"** on the unit, whether or not the song is loaded.
- Cause: the card's FAT/exFAT file system ignores case, so the new name "already exists".
- The failed rename **changed nothing**: names, WAVs and song.sys contents were identical in SD CARD 02.
- Workaround on the unit: rename in two steps (TV → `tvx` → `tv`).

### Current song
- ✅ Loading a song on the unit writes its name to tascam_m.sys 0x83C, null-padding the whole rest of the field (WANDERING → TV left zeros, not leftover letters).
- ✅ Loading also re-saves song.sys (new date, identical contents) and refreshes the `tempTr*_A.bin` files.
- The app's card bar shows it as "current song on device: …" (v2026-11-20.10).

## Card failure, 2026-11-19
- After copying SD CARD 03 (with "glitches" during the copy) and a power-cycle, the Model 12 showed "invalid format".
- On the computer, the old card showed `tv 2`, `epistem 01` and `EPISTEM_02` as empty folders, and reading TRAVELOGUE TR01 gave **Input/output error**.
- Conclusion: the card itself was failing (read errors). It wasn't caused by the renames, though the dangling current-song name could not be ruled out as a trigger for the start-up message.
- Recovery:
  - SD CARD 03 was verified complete: `diff -rq` against SD CARD 01, and `cmp` of `tv 2` against TV.
  - A new card was formatted on the computer, `MTR` + `MUSIC` were copied, and the copy was verified with `diff -rq`.
  - On the unit, everything works. The old card is retired.
- Lesson for the app: added "Check card" (reads every byte, reports unreadable files and a missing current song).

## App renames on the real card ✅ (2026-11-19, new card "MODEL12")
- **Chrome:** `WANDERING` → `wander 2`. Fast, every file moved, no errors. Chrome moves all file types, `song.sys` included.
- **Brave** (with the file-system-access flag on): `wander 2` → `wander test`. Every move refused, so every file was copied, verified byte for byte, and the originals deleted.
  - Result checked on the card: 25 files with their original sizes, old folder gone, no temporary leftovers.
  - tascam_m.sys 0x83C was updated to "wander test" (it was the current song), with the rest of the field zeroed.
- ❓ Still to confirm: the Model 12 loads and plays `wander test`.
- Later (2026-11-20) the songs on the card are: Epishape (was SHAPE_0001), EPISTEM_02, Epistemic01 (was EPISTEM_01), TRAVELOGUE, TV, WANDERING.

## App write rules (cardio.js)
- Write access only through the browser's File System Access API (Chrome, Edge, Vivaldi; Brave with `brave://flags/#file-system-access-api`). Firefox/Safari are read-only; the app then shows a "Read-only" badge (v2026-11-20.8: the badge is hidden when editing works).
- Chromium can move/rename files but not folders. So a rename means:
  1. create the new folder
  2. per file: **move** it into the new folder (renaming the track files); if the browser refuses (NotSupportedError, as Brave does), **copy** it instead. File types that were refused once aren't tried again that session.
  3. verify: moved files by name and size, copied files byte for byte against the original
  4. only then delete the originals of copied files, and remove the old folder non-recursively (so it fails if anything unexpected is left)
- A move only changes the directory entry; the audio is not copied. Copy mode rewrites the whole song (slower, more card wear), so Chrome is recommended for renaming.
- On any error before step 4, moves are undone and copies are deleted, and the user is told the song is unchanged.
- Case-only renames go through a temporary folder `tmmtmp_…`.
- **Temporary names** (v2026-11-20.5): all start with `tmmtmp_` (`tmmtmp_probe.bin`, `tmmtmp_new_…`, `tmmtmp_swap_…`, folder `tmmtmp_xxxxx`). Before that they started with `~`. ✅ Confirmed 2026-11-20: Chrome on a real disk refuses to create or move to names starting with `~` (the in-browser OPFS test card allows them). With v.5, Check card's write check and track editing worked on the real card. The e2e test now refuses `~` names the same way.
- ✅ A swap only renames files, so a file's read-only attribute moves with it (tested 2026-11-20); copy/clear/import replace the file, which makes it writable.
- Refused:
  - names over 11 characters
  - characters outside letters, digits, space and plain symbols (excludes `\ / : * ? " < > |` and accented letters)
  - a leading or trailing space, or a trailing dot
  - a name that matches another song when case is ignored
  - names starting with `tmmtmp_` or `~tmm` (reserved)
  - protected songs, and songs with warnings (missing files)
- Asks once per session to confirm the user has a copy of the card.
- The page shows its version (e.g. v2026-11-20.21), and script/style links carry `?v=`, so a stale cached copy is easy to spot. Installed as a PWA, the service worker's VERSION must match. The PWA only sees a new version while `serve.sh` is running; the Update bar then appears after reopening the app.
- Suggested install location (2026-11-20): app files in `~/.local/share/tascam-model-card-manager/`, a link `~/.local/bin/tascam-card-manager` → `serve.sh` (serve.sh resolves links with `readlink -f`), optionally a systemd user service so the server runs at login. Updates: rsync from the Dropbox app folder.
- Browser dark modes: the page has `<meta name="color-scheme" content="dark">` and `<meta name="darkreader-lock">`; the LCD, play button and faders use `color-scheme: only light`. Ben's dark-teal LCD (2026-11-20) came from the Dark Reader extension; Chrome's own auto dark mode doesn't change the app.
- The player display stays hidden (space reserved) until the page is loaded and painted, then fades in (v.20; Ben saw a dark frame for a few seconds when the installed app opened, intermittently).

### Read-only card or files (app v2026-11-20.2 to .5)
- Reported 2026-11-20: in Chrome, every copy failed with "Cannot write to a read-only file" (`createWritable`), and swap failed on `move` with no reason given.
- ✅ Found: the card was mounted `rw` (exFAT), but the 48 track WAVs of the four oldest songs (EPISTEM_01, EPISTEM_02, SHAPE_0001, TRAVELOGUE) had the **read-only file attribute** (`-r-xr-xr-x`). `song.sys`, all folders and the other songs (TV, WANDERING) were writable.
- ✅ This is **not** the unit's song protection: only EPISTEM_02 has the song.sys protect flag (0x20 = 1). The attribute was most likely carried over when the card was copied. Fix on Linux: `chmod -R u+w /media/ben/MODEL12`.
- **Write check before every change:** create and remove `MTR/tmmtmp_probe.bin`. If that fails, nothing is touched; the message names the possible causes (lock switch, read-only mount, read-only folder) and ends with the browser's own error ("The browser said: …").
- **Read-only single files on a writable card:** write `tmmtmp_new_<time>_<name>` in the same folder, verify it, remove the original, then rename the temp file to the original name (or, if the browser can't rename, copy it to a new file under that name, verify, and remove the temp file). Covers copy, clear, import, undo and export.
- **Swap:** if the first rename is refused for any reason, the app swaps the file contents instead.
- **Check card write check** (v2026-11-20.3): opens each file for writing and aborts at once (Chrome writes to a separate swap file, so the original is untouched), then lists read-only files per song with how to clear the attribute. A fully read-only card is reported once, with the browser's reason. Write permission is asked when Check card is clicked; without it the write check is skipped. ✅ Tested by Ben on the real card (TV TR07/08 made read-only → "TV (2 files)").
- **Check card** also lists any `tmmtmp_…` (or old `~tmm…`) files left behind by an interrupted change. Track file names are matched with an anchored pattern, so a leftover temp file is never mistaken for a track.
- After opening a card, a tip suggests running Check card ("Don't show again" is remembered in the browser).

### Track editing (app v2026-11-20.1), matching chapter 7 of the manual
- Purpose (Ben's workflow, also the manual's bounce tip on p.39): swap 11/12 to other tracks, clear the rest, record new parts on top.
- ✅ Nothing inside a track file says which track it is. TR07 vs TR11 headers only differ in RIFF size and the `bext` date/time. So moving audio between tracks is purely a matter of file contents under the target track's file name; song.sys has no per-track data.
- Channels, as on the unit's TRACK SWAP/CLEAR screens: single tracks 1–12 plus the pairs 7/8, 9/10, 11/12. Order: 1–8, 7/8, 9, 10, 9/10, 11, 12, 11/12. Single ↔ single and pair ↔ pair only. Labels in the app (v2026-11-20.2): "Track 1" … "Track 12", "Tracks 7/8", "Tracks 9/10", "Master 11/12".
- **Swap** (default, like TRACK SWAP): three file renames via a temporary name (`tmmtmp_swap_…`), so no audio is rewritten. If renaming is refused, the two files' contents are swapped and verified. Undo = swap again.
- **Copy:** the target file is rewritten with the source's bytes (Chrome writes to a swap file and replaces on close), then read back and compared. The source keeps its audio.
- **Clear** (like TRACK CLEAR, per single track): the track is rewritten as an empty track built from its own header: every chunk before the audio unchanged, then `data` with size 0, and the RIFF size updated.
  - ✅ Byte-identical to the unit's own empty tracks (5,548 bytes, 16- and 24-bit), except the `bext` recording date/time.
- **Import** (like TRACK IMPORT; source is the `MUSIC` folder or a file from the computer):
  - Targets must be empty. Mono goes to a single track, stereo to a pair; files with more than 2 channels are refused.
  - **Formats (v2026-11-20.14):** WAV (read directly), and FLAC, MP3, M4A/AAC, OGG, Opus (decoded by the browser with `OfflineAudioContext.decodeAudioData` at the song's sample rate). The format is sniffed from the first bytes; FLAC's STREAMINFO gives its rate and bit depth.
  - **Sample rate:** unlike the unit (which refuses), other rates are **converted** to the song's rate by the browser's decoder, and the dialog says so. Ben's decision 2026-11-20.
  - **Exactness:** WAV at the song's rate streams byte for byte (same depth) or is converted (TPDF dither down to 16-bit). FLAC at the song's rate and ≤ the song's bit depth: decoded floats are rounded back to the exact original samples (✅ e2e test: FLAC import = the WAV it was made from, bit for bit). Converted or lossy audio gets TPDF dither when going to 16-bit.
  - The new file is the empty target's own header (sizes updated, `bext` date/time set to now) followed by the audio.
  - The whole file is decoded in memory (≈200 MB for a 10-minute stereo file).
- **Export** (like STEREO MIX EXPORT): `MUSIC/<song>_2-MIX_01.wav` on the card (replacing an existing one, as the unit does after confirming), or a download. See the format below.
- **Undo:** replaced, cleared or overwritten audio is kept in browser memory until the app is closed; undo writes it back (verified). Redo re-runs the operation. On a failure halfway, already-written tracks are restored.
- In the preview mixer, 11/12 has its own strip, muted by default (it usually holds the mix of 1–10). A song always opens in Multitrack (v2026-11-20.6).
- ❓ Still to confirm on the unit: a song with swapped/copied/cleared/imported tracks loads, plays, and records over cleared tracks normally.

### Song info, protect, new song (app v2026-11-20.8 / .9)
Decisions with Ben, 2026-11-20:
- **metadata.txt at the card root** (not per song folder, because it's unknown whether the unit accepts unknown files in a song folder). Plain text, one `[FOLDER]` section per song, `key = value` lines for title, artist, genre, year, bpm (v.21), comment; newlines stored as `\n`, backslash as `\\`. Empty sections are left out. Rename moves the section along; saving info can be undone. (Replaced by the SETTINGS folder in v2026-11-21.1, see below.)
- **Default artist** (v.9): a `[*]` section (FAT names can't contain `*`) holds card-wide defaults. The first artist saved becomes the default; "Make … the default artist" changes it. Songs without an artist show and export the default. (Removed in v2026-11-21.1.)
- **Song info box** (v.9): one box under the song name, folded by default to a 34 px bar like the Multitrack bar: info icon + "Song info", then Title, Artist, Created, Size, Tempo (or Click), and an arrow on the right. Open: details plus the fields; Save in the bar. Open/closed is remembered. Spacing between the song header, Song info, the Multitrack bar and the console is 7 px (v.11, checked by a test). The player display shows the title (v.16) and scrolls a long one calmly: rest 4 s, 15 px/s, rest 2.5 s at the end (v.19).
- **Tags only outside the card:** exports to the card stay byte-identical to the unit's own (no tags). Downloads are FLAC only (since v.22–.27) with VORBIS_COMMENT tags (TITLE, ARTIST, GENRE, DATE, BPM, COMMENT, ENCODER) and the cover as PICTURE type 3. (Before that: WAV `LIST/INFO` + `id3 ` chunks after the data chunk.)
- **Card size (point 4):** a browser can't see the card's capacity or format, so the card bar shows only the total size of all files on the card ("x GB used"), as Ben asked.
- **Protect/Unprotect in the app:** writes only song.sys byte 0x20 (0/1), like SONG PROTECT. ✅ e2e test: only that byte changes. Use case: lock a song after setting it up with swaps/clears. Undo works.
- **Status icons:** pin = current song (0x83C), lock = protected; icons only, with tooltips, after the song name (list and header).
- **New song only from Import** ("Into a new song"): `MTR/<name>/` with
  - song.sys cloned from an existing song: one at the file's own sample rate if there is one, otherwise the selected song (the audio is then converted). Protect 0, marks cleared (0xFFFFFFFF), click tempo 120 (0x25C), 0x262 = 0, created date/time = now; all other bytes from the template (the sample rate's place in song.sys is unknown)
  - 12 empty tracks built from a unit-made track header of the template (preferably an empty one), `bext` date = now: 5,548 bytes like the unit's
  - the template's 0-byte `tempTr*_A.bin` files
  - then the import; if the import fails the new song is removed. Undo removes only the files the app made, then the folder (non-recursive).
- ❓ To confirm on the unit: a song created this way loads, plays and records; metadata.txt at the root doesn't bother the unit.
- Faders: mouse wheel (0.01 per step, shift ×5), double-click → 0 dB (0.75), the 0 dB mark flashes blue (2 px wider than the fader on both sides, v.18) when a fader reaches it, and a fader snaps to 0 dB only while dragged with the mouse.
- Player display (v.12): backlit LCD look (dark bezel, glowing light-blue screen, pixel grid, glass reflection, faint unlit "88:88:88"); rows: status + mode tag (MULTI / MAIN MIX / MIXDOWN), song title, large time, format (44.1k/16) + total length. Ben prefers this light version.

### Settings storage, rename, duplicate (app v2026-11-21.1 / .2)
Decisions with Ben, 2026-11-21:
- **SETTINGS folder** in the card root replaces metadata.txt. `SETTINGS/<song folder>.json` = `{app, format: 1, song, info: {title, artist, genre, year, bpm, comment}, mix}` (pretty-printed; mix as an object). `SETTINGS/_card_settings.json` = `{artists: [...], genres: [...]}`, the card's choice lists. JSON names are matched to song folders ignoring case. A file is removed when a song's settings become empty. A card with metadata.txt is read as before and converted on the first write; metadata.txt is then removed (its old `[*]` default artist goes onto the artists list).
- **No default artist / default mix** any more. Artist and genre fields offer the card's values (datalist autocomplete) and an empty field shows the most-used value, which only counts as a change when edited or saved. A song without its own mix opens with factory settings.
- **BPM → click tempo:** saving Song info with a BPM also writes round(BPM) to song.sys 0x25C (range 20–250, skipped for protected songs). One history entry; undo restores both.
- **Rename** by clicking the song title (contentEditable; Enter applies, Escape cancels). The Rename button is gone.
- **Duplicate:** copies every file of the song folder to a new folder, track files renamed like a rename, each verified; settings copied. Name: `<name>01` if ≤ 11 chars, else the last two characters replaced by `01`; on a clash 02, 03…. Protected songs can be duplicated. Undo removes only the copied files, the folder and the copy's settings. ❓ To confirm on the unit: a duplicated song loads and plays.
- **Multitrack bar:** a save light (flickers red while saving, green when saved) and a reset icon on the right.
- **Console (v.2):** two effects, FX 1 (default Hall 1) and FX 2 (default Delay 1), each with its own card, return fader and mute, and an FX 1 / FX 2 send knob per channel. Sends are post-fader and after MUTE/SOLO. The mix JSON holds `fx` and `fx2`; both are in the My mix render. A clip indicator under MAIN shows how far the main output went over 0 dBFS, held 4 s, flashing faster the harder it clips; a click clears it. The console and the right column scroll independently (the old auto-alignment of the main fader with the channel faders is gone).

### 12card v2026-11-21.3: delete, config files, normalise, mastering
Decisions with Ben, 2026-11-21:
- **Name: 12card** (repo `12card`; Ben's choice over mtrcard). Model 12 only: no Model 16/24 (Ben has only a 12; forks welcome). Linux first; Mac/Windows later by opening `index.html` in Chrome (no PWA needed there).
- **Delete song:** type DELETE to confirm, no undo. Removes every file in `MTR/<song>/` (also hidden files such as macOS `._*`), then the folder, then `SETTINGS/<song>.json`. Refused for protected songs and for song folders that contain a subfolder. If it was the current song, 0x83C is set to the newest remaining song (same bytes as the unit's load). Mixdowns in MUSIC stay. ❓ What the unit itself does on delete is still open (question 10).
- **Config files** (`config/card-model12.js`, `config/mixer.js`, `config/mastering.js`): plain JSON wrapped as `(globalThis.CFG12 ||= {}).x = {…};`, loaded with `<script>` tags so they also work from `file://` (fetch of local .json is blocked there; verified). Card format values (track count, main mix 11/12, offsets as hex strings, name rules, channel groups, console strips) moved out of the code into card-model12.js.
- **Import normalise:** BS.1770 loudness (K-weighting for any rate, 400 ms blocks, −70/−10 gates; matches ffmpeg ebur128). Ben's own tracks measure −22 to −48 LUFS (main mixes −29 to −41). Target −23 LUFS, peak ceiling −3 dBFS, ticked by default above −18 LUFS. With normalise on, audio is decoded + dithered (not exact).
- **Mastering** after the main fader (all playback modes and the My mix render; card exports untouched): presets in config/mastering.js as chains of blocks (eq, comp, width M/S with mono bass, saturate, room, wow, noise, gain, limiter = compressor + soft clipper at −1 dBFS). AMOUNT = dry/wet blend. Saved in the song's mix as `mastering: {preset, amount, loudness}`. LOUDNESS (−16/−14/−10 LUFS) applies to the My mix download: gain to target plus a look-ahead sample-peak limiter at −1 dBFS (ffmpeg confirms −14 LUFS). Saturation mixes dry inside the waveshaper curve (a separate dry path cancelled against the oversampled wet path).
- Song list shows size next to length; left column 210 px; song buttons go icon-only when their labels don't fit (measured from button widths, labels return when there's room); FX 2 is orange like FX 1.

### Marks ✅ (checked 2026-11-23 on the real card, TRAVELOGUE, one mark at 1,648,512 samples)
- The unit stores a mark in **two places**:
  1. song.sys 0xD0: 99 × uint32 sample positions, 0xFFFFFFFF = empty.
  2. **Every track file's header**: the `cue ` chunk (99 slots × 24 bytes: id, position, "data", chunk start 0, block start 0, sample offset). A used slot has id = n (e.g. `01 00 00 00`), position = sample offset = the mark. A free slot has id `n | 0xFF000000` (e.g. `02 00 00 ff`) and zeros. The LIST/adtl `labl` sub-chunks (12 bytes: cue id + 8 bytes of text) name used slots `MARK_01`; free ones are zero.
- An empty track made before the mark (TRAVELOGUE TR06 in the old copy) had no mark in its cue chunk, so the unit may only update tracks it writes. The app writes the cue chunk of every track file.
- **Body Mode (10 marks set on the unit, 2026-11-23):** song.sys holds all 10 marks. The recorded track TR07 has the same 10 in its cue chunk. The **empty tracks get no marks** in theirs.
- **Removed in v2026-11-23.3 (Ben's decision):** marks are set on the TASCAM; 12card only shows them and jumps to them. Writing marks into every track file made Chrome copy each whole file (`keepExistingData` = full swap copy, ~200 MB for TrainView). The card reader dropped off during that, and the app was left on its busy screen. Nothing was damaged (checked). The history of the attempt follows.
- **(withdrawn) 12card v2026-11-23.1:** M in the overview sets a mark at the play position. It writes song.sys and each track header in place (`createWritable({keepExistingData: true})`, header bytes only, verified, rolled back on error). Marks are kept in time order and named MARK_01… in that order. Undo is supported. The writer reproduces the unit's TRAVELOGUE bytes exactly (song.sys and TR01 header). ❓ To confirm on the unit: a mark set by the app shows up and MARK jumps work.

### Trim song (12card v2026-11-23.5)
- Background: Ben cut Epistemic01 in Audacity (stereo, 16-bit export, plain 44-byte header) and only one track played. Repaired from the SD CARD 01 backup; the Model 12 has no "song length" field (song.sys is the same apart from marks/protect), the length comes from the track files.
- Trim cuts every track with audio at the same sample: new file = the track's own header (RIFF size, data size changed; cue/LIST mark slots moved) + the kept audio copied byte for byte. The frame count is kept even for 24-bit so the data chunk needs no pad byte. Tracks shorter than the cut end at their own end. Empty tracks and tempTr*.bin are not touched.
- Marks: song.sys list and each track's cue chunk are shifted by the start; marks outside the kept part are dropped; slots rebuilt compacted (used 1…n, `MARK_nn`; free `n|0xFF000000`, empty label). Tracks with no used slots keep their cue/LIST bytes.
- Write order: all new tracks written as `tmmtmp_trim_NN.wav` in the song folder and verified (keepExistingData false, streamed), then originals moved to `SETTINGS/trim-undo/<yyyymmdd-hhmmss>_<song>/` (with `trim.json`) and the new files renamed; song.sys written in place (2 KB). Any error → everything moved back. Undo/redo exchange the two sets by moves. On opening the card 12card offers to delete `SETTINGS/trim-undo`.
- Find silence: first/last sample above −60 dBFS on any track, scanning 1 s blocks from each end, keeping 0.25 s before and 1 s after.
- ✅ Ben checked a trim on 2026-11-23: works as expected.

### 12card v2026-11-23.1 (other changes)
- **Song info:** gains `description` (SETTINGS JSON `info.description`; FLAC `DESCRIPTION`). FLAC `DATE` = the recording date from song.sys (YYYY-MM-DD) when the Year field is empty or matches it, otherwise the year.
- **Downloads:** optional silence trim. Start = ¼ s before the first sample above peak − 48 dB, end = 1 s after the last. The recorded mix is cut only, with no other change to samples.
- **Main mix mode:** all channel strips and the effects are inert (the 11/12 recording goes straight to MAIN). Empty-track strips are inert too.
- **Console snapshots:** 3 slots plus "as opened", in memory per song.

### Tempo (app v2026-11-20.21)
- ✅ **The Model 12 does not store the tempo a song was played at.** Ben: WANDERING is 86 BPM, TRAVELOGUE 119 BPM. Neither 86 nor 119 occurs anywhere in their song.sys, as u8, u16, u32, ×10, ×100 or float32.
- ✅ song.sys 0x25C is therefore the **metronome (click) tempo setting**: 120 (default) in every song except TRAVELOGUE (95), which is also the only song with 0x262 = 1 (probably click on). ❓ Ben can confirm by checking TRAVELOGUE's click tempo on the unit.
- The app shows 0x25C as "Click 120 BPM" and has a **BPM** field in Song info (`bpm`). The BPM, when set, is shown as "Tempo", drives the delay effects' tempo sync, and goes into downloaded tags.
- **Detect** estimates the tempo from the audio (main mix on 11/12, else tracks 1–10 summed): downsample to ~11 kHz, spectral-flux onset envelope (512-point FFT, hop 128 ≈ 86 frames/s), local-mean removal, autocorrelation; pick the beat from strength at 1 and 2 beats with a log-normal preference centred on 110 BPM (σ 0.6 octave), then fine-tune ±3% using 8 beats. Needs ≥ 8 s. ✅ WANDERING → 86.1, TRAVELOGUE → 119.0 (a simpler 1-beat version gave 79.4 = ⅔ × 119 on TRAVELOGUE). Synthetic beats 86–140 BPM within 1 BPM. About 1.3 s for a 4-minute song. It fills the field as a suggestion (plus half/double alternatives in the message); Save keeps it.

### Stereo mix export format ✅ (compared with the unit's EPISTEM_01_2-MIX_01.wav)
- Same chunk layout as a track file: `bext` 1116, `cue ` 2380, `LIST` 1984, `fmt ` 16, then `data`. The header is 5,548 bytes.
- Header = TR11's header with only these changed: RIFF size, `fmt` channels = 2, byte rate, block align, data size, and the `bext` origination date/time (= export time).
- Audio = TR11 (left) and TR12 (right) interleaved, byte for byte.
- ✅ The app's export of `epistem 01` is identical to the unit's own export (12,032,428 bytes), apart from the export time. Re-checked for v2026-11-21.2. Test: `tests/export_vs_unit.test.js "<card copy>" "epistem 01" EPISTEM_01_2-MIX_01.wav`.
- Name: `<song name>_2-MIX_01.wav`. Above 2 GB the manual says the unit splits into `_02`, `_03`; the app splits at 2^31−1 bytes per file.

## Track WAVs
- ✅ Mono PCM, 44.1/48 kHz, 16 or 24-bit. Chunks: `bext` (originator "TASCAM Model12", BWF date/time), `cue ` (99 slots = marks), `LIST/adtl` labels, `fmt `, `data`.
- ✅ **An empty track is a 5,548-byte file**: the same chunks as a full track, with a `data` chunk of size 0. So the "x/12 tracks used" count only needs file sizes.
- Track mapping (from the manual): TR01–06 mono channels, TR07/08 and TR09/10 stereo pairs, TR11/12 = MAIN MIX L/R recording (useful for "quick listen").
- TRAVELOGUE is 24-bit; WANDERING 16-bit (both 44.1 kHz).

## song.sys (2048 bytes, little-endian)
| Offset | Size | Meaning | Status |
|---|---|---|---|
| 0x00 | 8 | magic `"MODEL   "` | ✅ |
| 0x08 | 4 | version? `03 00 02 00` | ❓ |
| 0x20 | 1 | **protect flag**: 0 = off, 1 = protected (on the MODEL12 card: only EPISTEM_02) | ✅ tested |
| 0x36 | 1 | bytes per sample: 2 = 16-bit, 3 = 24-bit | ✅ (matches WAV fmt) |
| 0x5C | 2 | FAT date (yyyyyyy mmmm ddddd, year+1980) | ✅ creation date |
| 0x5E | 2 | FAT time (hhhhh mmmmmm sssss×2) | ✅ |
| 0xD0 | 99×4 | mark positions in samples, `FFFFFFFF` = empty | ✅ likely (TRAVELOGUE has 1 mark) |
| 0x25C | 1 | **metronome (click) tempo** setting, default 120 (TRAVELOGUE = 95). Not the song's playing tempo. The app writes round(BPM) here on Save (v2026-11-21.1). | ✅ (2026-11-20) |
| 0x262 | 1 | 0/1 flag, only set in TRAVELOGUE (not protect). Click on? | ❓ |
| 0x260–0x28F | | other settings (click etc.) | ❓ |

The Model 12 has no time-signature setting that Ben could find on the unit.

Decoded creation dates: EPISTEM_01 2024-10-29, EPISTEM_02 2025-04-16, SHAPE_0001 2025-04-17, TRAVELOGUE 2025-09-21, TV 2025-10-17, WANDERING 2026-09-10.

No mixer state (faders/EQ/pan) was found in song.sys. Mixer settings on the Model 12 are physical knobs, so the app's mixer is for preview only.

## tascam_m.sys (2360 bytes)
| Offset | Meaning | Status |
|---|---|---|
| 0x00 | magic `"TASCAM_M"` + `01 00 01 00` | ✅ |
| 0x838 | uint32, 1259136; unchanged across song loads and renames, so probably not a play position | ❓ |
| 0x83C | name of current/last loaded song, null-padded. Not updated by a rename on the unit. | ✅ |

## Open questions (need on-device experiments)
1. **New song from Import:** the Model 12 loads, plays and records a song the app created (v2026-11-20.8).
2. **SETTINGS folder:** the unit starts and works normally with the SETTINGS folder in the card root.
3. **Imported FLAC / converted-rate tracks:** play normally on the unit (they're ordinary track WAVs, so expected to).
4. **Click tempo:** TRAVELOGUE's metronome tempo on the unit is 95 (confirms 0x25C); toggle the click on/off to see whether that's 0x262.
5. **App rename on the unit:** load and play a song renamed by the app (e.g. "wander test", "Epishape").
6. **Track edits on the unit:** after "swap 11/12 ⇄ 7/8" plus "clear all except 7/8" in the app, the song loads, 7/8 plays the old mix, and new recordings on the cleared tracks work. Same for an imported track, and an app-exported mix in SD PLAY mode.
7. **Protect from the app:** a song protected in the app shows as protected on the unit.
8. **Dangling current song:** does the unit start normally when 0x83C names a song that doesn't exist? Test on a healthy card (rename the loaded song on the unit, power-cycle).
9. **48 kHz song:** confirm where the sample rate is stored in song.sys.
10. **Delete:** delete a song on the unit and diff tascam_m.sys.
11. **0x838** in tascam_m.sys: what is it?
13. **Marks from the app:** a mark set with M in 12card shows on the unit, and MARK jumps work.
12. **Duplicate and click tempo from the app:** a duplicated song loads and plays; a click tempo written by the app shows on the unit.
