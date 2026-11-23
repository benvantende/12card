/* 12card configuration: mastering presets on the main output, and levels.
 * Everything between the first { and the last } is plain JSON: edit it like a .json file.
 *
 * A preset is a chain of blocks, processed top to bottom. Block types (see master.js for details):
 *   eq       { "bands": [{ "type": "lowshelf|highshelf|peaking|lowpass|highpass", "freq": Hz, "gain": dB, "q": Q }] }
 *   comp     { "threshold": dB, "ratio": n, "attack": s, "release": s, "knee": dB, "makeup": dB }
 *   width    { "amount": 1 = as is, 0 = mono, 1.5 = wider, "monoBelow": Hz }
 *   saturate { "curve": "soft|tape|tube", "drive": dB, "mix": 0-1 }
 *   room     { "mix": 0-1, "seconds": s, "damp": 0-1 }
 *   wow      { "rate": Hz, "depth": ms, "flutterRate": Hz, "flutterDepth": ms }
 *   noise    { "kind": "vinyl|tape|hum", "level": dBFS }
 *   gain     { "db": dB }
 *   limiter  { "ceiling": dBFS }
 * To change a preset that doesn't sound right, edit its blocks; to add one, copy a preset and give it a new "id".
 * A song remembers its preset by id. */
(globalThis.CFG12 = globalThis.CFG12 || {}).mastering =
{
  "importNormalise": {
    "target": -23,
    "peakCeiling": -3,
    "suggestAbove": -18,
    "comment": "Import: 'Normalise the level' brings a file to target LUFS (peaks no higher than peakCeiling dBFS). It is ticked by default when a file is louder than suggestAbove LUFS. Tracks recorded on the Model 12 are typically -45 to -22 LUFS."
  },

  "loudnessTargets": [
    { "lufs": null, "label": "Off" },
    { "lufs": -16,  "label": "−16 LUFS (podcasts, Apple Music)" },
    { "lufs": -14,  "label": "−14 LUFS (Spotify, YouTube)" },
    { "lufs": -10,  "label": "−10 LUFS (loud, club)" }
  ],
  "loudnessCeiling": -1,

  "presets": [
    {
      "id": "punch", "name": "Punch",
      "description": "Tighter low end and more impact: the compressor lets the attack of each hit through.",
      "chain": [
        { "block": "eq", "bands": [{ "type": "highpass", "freq": 28 }, { "type": "peaking", "freq": 90, "gain": 2.5, "q": 0.9 }, { "type": "peaking", "freq": 400, "gain": -1.5, "q": 1 }, { "type": "peaking", "freq": 3000, "gain": 1.5, "q": 0.8 }] },
        { "block": "comp", "threshold": -20, "ratio": 3, "attack": 0.03, "release": 0.15, "knee": 4, "makeup": 4 },
        { "block": "limiter", "ceiling": -1 }
      ]
    },
    {
      "id": "crystal", "name": "Crystal stereo",
      "description": "Clear and open: less mud, more air on top and a slightly wider image.",
      "chain": [
        { "block": "eq", "bands": [{ "type": "highpass", "freq": 30 }, { "type": "peaking", "freq": 300, "gain": -2, "q": 0.8 }, { "type": "highshelf", "freq": 9000, "gain": 3 }] },
        { "block": "width", "amount": 1.3, "monoBelow": 150 },
        { "block": "comp", "threshold": -18, "ratio": 1.6, "attack": 0.02, "release": 0.25, "makeup": 2 },
        { "block": "limiter", "ceiling": -1 }
      ]
    },
    {
      "id": "ambience", "name": "Ambience",
      "description": "Puts the whole mix in a soft, airy space.",
      "chain": [
        { "block": "room", "mix": 0.22, "seconds": 2.4, "damp": 0.6 },
        { "block": "eq", "bands": [{ "type": "highshelf", "freq": 8000, "gain": 1 }] },
        { "block": "width", "amount": 1.15, "monoBelow": 120 },
        { "block": "comp", "threshold": -20, "ratio": 1.5, "attack": 0.03, "release": 0.3, "makeup": 1.5 },
        { "block": "limiter", "ceiling": -1 }
      ]
    },
    {
      "id": "vocal", "name": "Vocal presence",
      "description": "Brings voices forward: less boxiness, more presence around 3 kHz, gentle levelling.",
      "chain": [
        { "block": "eq", "bands": [{ "type": "highpass", "freq": 40 }, { "type": "peaking", "freq": 250, "gain": -2, "q": 1 }, { "type": "peaking", "freq": 3000, "gain": 3, "q": 1.2 }, { "type": "highshelf", "freq": 12000, "gain": 1.5 }] },
        { "block": "comp", "threshold": -22, "ratio": 2, "attack": 0.01, "release": 0.2, "makeup": 3 },
        { "block": "limiter", "ceiling": -1 }
      ]
    },
    {
      "id": "kick", "name": "Kick",
      "description": "More weight and click on the kick drum; the bass is kept in mono.",
      "chain": [
        { "block": "eq", "bands": [{ "type": "highpass", "freq": 30 }, { "type": "peaking", "freq": 60, "gain": 4, "q": 1.1 }, { "type": "peaking", "freq": 350, "gain": -2, "q": 1.2 }, { "type": "peaking", "freq": 4000, "gain": 1.5, "q": 1.5 }] },
        { "block": "width", "amount": 1, "monoBelow": 120 },
        { "block": "comp", "threshold": -20, "ratio": 3, "attack": 0.025, "release": 0.12, "makeup": 3 },
        { "block": "limiter", "ceiling": -1 }
      ]
    },
    {
      "id": "wide", "name": "Stereo enhance",
      "description": "A clearly wider stereo image, with the bass kept in the middle.",
      "chain": [
        { "block": "width", "amount": 1.6, "monoBelow": 200 },
        { "block": "eq", "bands": [{ "type": "highshelf", "freq": 8000, "gain": 1 }] },
        { "block": "limiter", "ceiling": -1 }
      ]
    },
    {
      "id": "nature", "name": "Nature",
      "description": "Natural and unforced: slow, light compression, a touch of air and open space.",
      "chain": [
        { "block": "eq", "bands": [{ "type": "highpass", "freq": 25 }, { "type": "highshelf", "freq": 12000, "gain": 1 }] },
        { "block": "comp", "threshold": -24, "ratio": 1.4, "attack": 0.04, "release": 0.4, "makeup": 1.5 },
        { "block": "room", "mix": 0.08, "seconds": 1.4, "damp": 0.4 },
        { "block": "limiter", "ceiling": -1 }
      ]
    },
    {
      "id": "sixties", "name": "Sixties",
      "description": "Narrow, mid-heavy and warm, with tube saturation and a plate-like room.",
      "chain": [
        { "block": "eq", "bands": [{ "type": "highpass", "freq": 80 }, { "type": "lowpass", "freq": 9000 }, { "type": "peaking", "freq": 1500, "gain": 2.5, "q": 0.8 }] },
        { "block": "saturate", "curve": "tube", "drive": 6, "mix": 0.5 },
        { "block": "width", "amount": 0.45 },
        { "block": "comp", "threshold": -20, "ratio": 3, "attack": 0.01, "release": 0.3, "makeup": 3 },
        { "block": "room", "mix": 0.12, "seconds": 1.6, "damp": 0.7 },
        { "block": "noise", "kind": "tape", "level": -66 },
        { "block": "limiter", "ceiling": -1 }
      ]
    },
    {
      "id": "seventies", "name": "Seventies",
      "description": "Warm and round: more low end, softer highs, tape saturation and glue.",
      "chain": [
        { "block": "eq", "bands": [{ "type": "lowshelf", "freq": 120, "gain": 2 }, { "type": "peaking", "freq": 2500, "gain": -1, "q": 0.8 }, { "type": "highshelf", "freq": 10000, "gain": -1.5 }] },
        { "block": "saturate", "curve": "tape", "drive": 4, "mix": 0.6 },
        { "block": "comp", "threshold": -20, "ratio": 2.5, "attack": 0.02, "release": 0.2, "makeup": 3 },
        { "block": "width", "amount": 0.95 },
        { "block": "limiter", "ceiling": -1 }
      ]
    },
    {
      "id": "analog", "name": "Analog",
      "description": "Subtle console colour: a little saturation and 2:1 glue, slightly softer highs.",
      "chain": [
        { "block": "saturate", "curve": "tape", "drive": 3, "mix": 0.6 },
        { "block": "eq", "bands": [{ "type": "lowshelf", "freq": 100, "gain": 1 }, { "type": "highshelf", "freq": 14000, "gain": -1 }] },
        { "block": "comp", "threshold": -18, "ratio": 2, "attack": 0.03, "release": 0.3, "makeup": 2 },
        { "block": "limiter", "ceiling": -1 }
      ]
    },
    {
      "id": "vinyl", "name": "Vinyl",
      "description": "A record: rolled-off extremes, mono bass, a slight warp, crackle and rumble.",
      "chain": [
        { "block": "eq", "bands": [{ "type": "highpass", "freq": 40 }, { "type": "lowpass", "freq": 14000 }, { "type": "lowshelf", "freq": 90, "gain": 1.5 }] },
        { "block": "width", "amount": 0.9, "monoBelow": 200 },
        { "block": "saturate", "curve": "soft", "drive": 2, "mix": 0.5 },
        { "block": "wow", "rate": 0.55, "depth": 0.35 },
        { "block": "noise", "kind": "vinyl", "level": -44 },
        { "block": "limiter", "ceiling": -1 }
      ]
    },
    {
      "id": "tape", "name": "Tape",
      "description": "A tape machine: saturation, head bump in the low end, softer highs, wow and flutter, a little hiss.",
      "chain": [
        { "block": "saturate", "curve": "tape", "drive": 6, "mix": 0.7 },
        { "block": "eq", "bands": [{ "type": "peaking", "freq": 80, "gain": 1.5, "q": 1 }, { "type": "highshelf", "freq": 12000, "gain": -2 }] },
        { "block": "wow", "rate": 0.8, "depth": 0.2, "flutterRate": 6, "flutterDepth": 0.04 },
        { "block": "comp", "threshold": -20, "ratio": 1.8, "attack": 0.02, "release": 0.25, "makeup": 2 },
        { "block": "noise", "kind": "tape", "level": -62 },
        { "block": "limiter", "ceiling": -1 }
      ]
    }
  ]
}
;
