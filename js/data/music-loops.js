// Intro and loop points for the mp3s in assets/music/, measured from the files themselves.
//
// Every one of those files is a ~30 minute "extended" upload: a short unit of audio repeated
// over and over. `loopLen` is that unit, recovered by autocorrelating the loudness envelope for
// a coarse period, aligning to the sample, then confirming the choice by the median waveform
// mismatch across the whole file (0.006-0.047 of mean square, i.e. the repeats really are the
// same audio). Every period below was found independently at two different file offsets and
// agreed to the sample.
//
// `introEnd` is where periodicity begins: audio before it never recurs, so it must play once and
// then be left behind. Eleven of the fifteen have introEnd 0 - the uploader looped the whole
// track, intro included - so for those the whole unit repeats and there is nothing to skip.
//
// Times are seconds from the start of the ORIGINAL 30 minute file. To trim: keep 0 -> trimTo.
// loopStart/loopEnd are then the loop points within that trimmed file.
//
// Precision is +-0.05 ms (analysis ran at 22.05 kHz). Note that looping an mp3 with
// HTMLAudioElement.loop inserts a short gap regardless of these numbers, because mp3 carries
// encoder delay and padding; for a seamless loop decode to an AudioBuffer and use an
// AudioBufferSourceNode with loop/loopStart/loopEnd.
export const MUSIC_LOOPS = {
  'Aegis Cave.mp3':                          { introEnd: 0,      loopStart: 0,      loopEnd: 159.985, loopLen: 159.985, trimTo: 159.985 },
  'Apple Woods.mp3':                         { introEnd: 0,      loopStart: 0,      loopEnd: 171.954, loopLen: 171.954, trimTo: 171.954 },
  'Barren Valley.mp3':                       { introEnd: 0,      loopStart: 0,      loopEnd: 213.305, loopLen: 213.305, trimTo: 213.305 },
  'Beach Cave.mp3':                          { introEnd: 0,      loopStart: 0,      loopEnd: 105.491, loopLen: 105.491, trimTo: 105.491 },
  'Crystal Cave.mp3':                        { introEnd: 0,      loopStart: 0,      loopEnd: 186.636, loopLen: 186.636, trimTo: 186.636 },
  'Dark Wasteland.mp3':                      { introEnd: 115.5,  loopStart: 115.5,  loopEnd: 217.143, loopLen: 101.643, trimTo: 217.143 },
  "Dialga's Fight to the Finish.mp3":        { introEnd: 88.0,   loopStart: 88.0,   loopEnd: 188.528, loopLen: 100.528, trimTo: 188.528 },
  'Drenched Bluff.mp3':                      { introEnd: 0,      loopStart: 0,      loopEnd: 162.559, loopLen: 162.559, trimTo: 162.559 },
  'Hidden Land.mp3':                         { introEnd: 0,      loopStart: 0,      loopEnd: 101.789, loopLen: 101.789, trimTo: 101.789 },
  'Pokémon Exploration Team Theme.mp3':      { introEnd: 0,      loopStart: 0,      loopEnd: 76.613,  loopLen: 76.613,  trimTo: 76.613 },
  'Pokémon Platinum - Wild Battle Theme.mp3':{ introEnd: 13.6,   loopStart: 13.6,   loopEnd: 71.006,  loopLen: 57.406,  trimTo: 71.006 },
  'Quicksand Cave.mp3':                      { introEnd: 0,      loopStart: 0,      loopEnd: 132.384, loopLen: 132.384, trimTo: 132.384 },
  'Steam Cave.mp3':                          { introEnd: 0,      loopStart: 0,      loopEnd: 214.445, loopLen: 214.445, trimTo: 214.445 },
  'Temporal Tower.mp3':                      { introEnd: 121.25, loopStart: 121.25, loopEnd: 256.107, loopLen: 134.857, trimTo: 256.107 },
  'Vast Ice Mountain Peak.mp3':              { introEnd: 0,      loopStart: 0,      loopEnd: 115.203, loopLen: 115.203, trimTo: 115.203 },
};

// Caveats worth knowing before you cut anything:
//
// Dialga's Fight to the Finish - the only fuzzy boundary. Its mismatch does not fall off a cliff;
//   it decays from ~82 s and only settles at ~88 s, which is what a crossfade in the upload looks
//   like. 88.0 is the conservative choice (loop entirely inside matched audio). 82.15 is where
//   the intro proper ends if you would rather not lose those 6 seconds.
//
// Crystal Cave (first 0.4 s) and Pokémon Exploration Team Theme (first 1.0 s) do not match their
//   own repeat at the very start - a fade-in on the upload, not an intro. Same for the fade-in
//   measured on Platinum (74% amplitude over the first 2 s) and Temporal Tower (74%), though on
//   those two it falls inside a real intro. For the introEnd-0 tracks you can dodge the artifact
//   entirely by cutting the SECOND unit instead of the first: -ss loopLen -t loopLen.
//
// Aegis Cave, Drenched Bluff, Quicksand Cave and Steam Cave repeat cleanly only at the lengths
//   above; exactly half of each is a near-repeat (same music, audibly different rendering), so
//   halving them to save space will not loop cleanly.
