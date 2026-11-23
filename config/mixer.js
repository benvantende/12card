/* 12card configuration: the preview console (channel strips and the two effects).
 * Everything between the first { and the last } is plain JSON: edit it like a .json file.
 * Fader positions run from 0 to 1; 0.75 is 0 dB and 1 is +5 dB, like the unit's faders. */
(globalThis.CFG12 = globalThis.CFG12 || {}).mixer =
{
  "stripDefaults": { "comp": 0, "hi": 0, "freq": 0.5, "mid": 0, "lo": 0, "fx": 0, "fx2": 0, "pan": 0, "fader": 0.75, "mute": false, "solo": false },
  "mainFader": 0.75,

  "knobs_comment": "The rows of knobs on every strip, top to bottom. unit: shown after the value. show: a built-in display (freq, pan).",
  "knobs": [
    { "key": "comp", "label": "COMP",  "class": "comp", "min": 0,   "max": 1,  "default": 0 },
    { "key": "hi",   "label": "HIGH",  "class": "eq",   "min": -15, "max": 15, "default": 0,   "unit": " dB" },
    { "key": "freq", "label": "FREQ",  "class": "eq",   "min": 0,   "max": 1,  "default": 0.5, "show": "freq" },
    { "key": "mid",  "label": "MID",   "class": "eq",   "min": -15, "max": 15, "default": 0,   "unit": " dB" },
    { "key": "lo",   "label": "LOW",   "class": "eq",   "min": -15, "max": 15, "default": 0,   "unit": " dB" },
    { "key": "fx",   "label": "FX 1",  "class": "fx",   "min": 0,   "max": 1,  "default": 0 },
    { "key": "fx2",  "label": "FX 2",  "class": "fx2",  "min": 0,   "max": 1,  "default": 0 },
    { "key": "pan",  "label": "PAN",   "class": "pan",  "min": -1,  "max": 1,  "default": 0,   "show": "pan" }
  ],

  "effects_comment": "The two effects a song starts with. type: one of the 16 Model 12 effect types (see fx.js). param 'default' = the type's own default.",
  "effects": [
    { "name": "FX 1", "type": "HALL1",  "param": 0.5,       "return": 0.75, "mute": false },
    { "name": "FX 2", "type": "DELAY1", "param": "default", "return": 0.75, "mute": false }
  ]
}
;
