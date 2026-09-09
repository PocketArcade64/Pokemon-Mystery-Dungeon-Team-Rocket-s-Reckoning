// Where each track's intro ends and how long its loop is, measured from the files in
// assets/Music Shortened/ themselves.
//
// Every one of those files is an official OST rip with the same shape: a one-off intro, then the
// loop played through TWICE, then a fade-out. So the game must play 0 -> loopEnd once and then
// keep looping [loopStart, loopEnd) — that skips the second pass and never reaches the fade.
//
// How the numbers were found. The loop length is the peak of the mean-removed autocorrelation of
// the loudness envelope (50 Hz frames, parabolic-interpolated), then locked to the sample by
// minimising waveform mismatch through 3 kHz -> 12 kHz -> 48 kHz passes; bass content is what the
// alignment rides on. `loopStart` is where periodicity begins: the first point whose 2 s envelope
// window still matches the window one loop later and keeps matching to the fade. Each pair was
// then checked against the file itself — loopStart + 2 * loopLen has to land on the start of the
// fade-out, and for 15 of the 16 it does within a few seconds.
//
// IMPORTANT, and the reason audio.js crossfades the seam: the two passes are NOT the same audio
// repeated. They are separate renders of the same music. At the loop lag the loudness envelope
// matches almost exactly (mismatch 0.002-0.06) while the waveform does not match at all, and the
// third-octave spectra correlate 0.86 with the divergence piled up in the high bands — reverb
// tails and note phase differ between passes. So there is no sample-exact splice to find, and
// joining loopEnd -> loopStart raw can click. audio.js blends across the seam instead.
export const MUSIC_LOOPS = {
  '01. Pokémon Exploration Team Theme.mp3':  { loopStart: 12.0, loopEnd: 45.2269,  loopLen: 33.2269 },
  '05. Beach Cave.mp3':                      { loopStart: 0,    loopEnd: 52.7522,  loopLen: 52.7522 },
  '12. Drenched Bluff.mp3':                  { loopStart: 0,    loopEnd: 81.2803,  loopLen: 81.2803 },
  '15. Battle! (Wild Pokémon).mp3':          { loopStart: 12.5, loopEnd: 69.9072,  loopLen: 57.4072 },
  '27. Victory! (Trainer Battle).mp3':       { oneShot: true },
  '29. Apple Woods.mp3':                     { loopStart: 0,    loopEnd: 85.9950,  loopLen: 85.9950 },
  '34. Steam Cave.mp3':                      { loopStart: 0,    loopEnd: 107.2293, loopLen: 107.2293 },
  '41. Quicksand Cave.mp3':                  { loopStart: 0,    loopEnd: 66.2037,  loopLen: 66.2037 },
  '43. Crystal Cave.mp3':                    { loopStart: 0,    loopEnd: 93.3196,  loopLen: 93.3196 },
  '58. Hidden Land.mp3':                     { loopStart: 0,    loopEnd: 103.6223, loopLen: 103.6223 },
  '64. Temporal Tower.mp3':                  { loopStart: 8.5,  loopEnd: 143.7570, loopLen: 135.2570 },
  "68. Dialga's Fight to the Finish!.mp3":   { loopStart: 32.0, loopEnd: 132.5298, loopLen: 100.5298 },
  '90. Aegis Cave.mp3':                      { loopStart: 0,    loopEnd: 79.9935,  loopLen: 79.9935 },
  '127. Barren Valley.mp3':                  { loopStart: 18.0, loopEnd: 124.6614, loopLen: 106.6614 },
  '128. Dark Wasteland.mp3':                 { loopStart: 14.0, loopEnd: 115.6394, loopLen: 101.6394 },
  '135. Vast Ice Mountain Peak.mp3':         { loopStart: 0,    loopEnd: 115.5387, loopLen: 115.5387 },
};

// Per-track notes, worth reading before changing any number above:
//
// Victory! (Trainer Battle) is the one one-shot. It is a 36 s fanfare that resolves and fades, so
//   it is played once and left to end rather than looped.
//
// Hidden Land is the one low-confidence loop length. Its envelope autocorrelation only reaches
//   0.602 (the rest run 0.75-0.97) because the track is sparse and ambient, and no clean
//   "periodicity starts here" point exists anywhere in it. 103.6223 is trusted because two passes
//   of it (207.2 s) match the file's content length almost exactly (fade begins at 211.5 s). If it
//   ever sounds like it loops mid-phrase, this is the number to re-measure.
//
// loopStart precision is +-0.5 s (the search grid), and that is deliberately biased LATE on the
//   six tracks that have an intro. Landing slightly late is harmless — the loop is still exactly
//   loopLen long, so the music stays in time and the wrap lands on equivalent material. Landing
//   EARLY is the audible failure: you would hear the tail of the intro again on every wrap.
//
// The eleven floor themes carry the theme ids from THEMES in js/dungeon.js. assets/music/ holds an
// older, superseded set: ~30 minute "extended" uploads at ~30 MB each. Those are not used any
// more and their loop points do not apply to these files.
