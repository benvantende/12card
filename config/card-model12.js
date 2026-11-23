/* 12card configuration: the TASCAM Model 12 card format.
 * Everything between the first { and the last } is plain JSON: edit it like a .json file.
 * Byte positions are written as hex strings ("0x20"). Track numbers count from 1, like on the unit.
 * Background and test results: claude/model12-sd-card-format.md in the project. */
(globalThis.CFG12 = globalThis.CFG12 || {}).model =
{
  "name": "Model 12",
  "tracks": 12,
  "mainMix": [11, 12],
  "maxSongs": 100,
  "songNameMax": 11,
  "songNameAllowed": "^[A-Za-z0-9 !#$%&'()+,\\-.;=@[\\]^_`{}~]*$",
  "folders": { "songs": "MTR", "mixdowns": "MUSIC" },
  "cardFile": "tascam_m.sys",
  "songFile": "song.sys",
  "trackFile": "^(\\d\\d)_(.*)_TR(\\d\\d)\\.wav$",
  "songSysSize": 2048,
  "emptyTrackMaxBytes": 8192,
  "headerReadBytes": 16384,

  "songSys": {
    "magic": "0x00",
    "protect": "0x20",
    "bytesPerSample": "0x36",
    "fatDate": "0x5C",
    "fatTime": "0x5E",
    "marks": "0xD0",
    "markSlots": 99,
    "clickTempo": "0x25C",
    "clickTempoRange": [20, 250],
    "flag262": "0x262"
  },

  "cardSys": {
    "magic": "0x00",
    "lastPos": "0x838",
    "currentSong": "0x83C"
  },

  "channels_comment": "Track groups offered by Swap / copy and Clear, in the order of the unit's TRACK SWAP and TRACK CLEAR screens.",
  "channels": [
    { "id": "1", "tracks": [1] }, { "id": "2", "tracks": [2] }, { "id": "3", "tracks": [3] }, { "id": "4", "tracks": [4] },
    { "id": "5", "tracks": [5] }, { "id": "6", "tracks": [6] }, { "id": "7", "tracks": [7] }, { "id": "8", "tracks": [8] },
    { "id": "7/8", "tracks": [7, 8] },
    { "id": "9", "tracks": [9] }, { "id": "10", "tracks": [10] }, { "id": "9/10", "tracks": [9, 10] },
    { "id": "11", "tracks": [11] }, { "id": "12", "tracks": [12] }, { "id": "11/12", "tracks": [11, 12] }
  ],

  "strips_comment": "Channel strips of the preview console. mixRec: holds the recorded main mix, so it starts muted.",
  "strips": [
    { "id": "1", "tracks": [1] }, { "id": "2", "tracks": [2] }, { "id": "3", "tracks": [3] },
    { "id": "4", "tracks": [4] }, { "id": "5", "tracks": [5] }, { "id": "6", "tracks": [6] },
    { "id": "7/8", "tracks": [7, 8], "stereo": true },
    { "id": "9/10", "tracks": [9, 10], "stereo": true },
    { "id": "11/12", "tracks": [11, 12], "stereo": true, "mixRec": true }
  ]
}
;
