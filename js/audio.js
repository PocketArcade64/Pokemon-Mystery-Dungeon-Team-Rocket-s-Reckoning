// Two independent audio systems with independent volume sliders in Settings:
//
//   SFX   — synthesized with WebAudio by default, with a SAMPLE overriding the synth wherever one
//           of the files in SFX_FILES exists (the stairs, evolving, and a Pokemon joining).
//   MUSIC — the user-supplied Explorers of Sky mp3s named in TRACKS below.
//
// A MISSING MUSIC FILE IS SILENCE, NOT AN ERROR. The mp3s are dropped in later; every track is
// probed once, a failure marks it unavailable, and the game carries on. Never gate anything on a
// track existing. A missing SFX SAMPLE is different: it falls back to the synthesized version, so
// that effect is never silent.
import { state } from './state.js';
import { MUSIC_LOOPS } from './data/music-loops.js';

const MUSIC_DIR = 'assets/Music Shortened/';
// The sound-effect samples live in the same folder as the music — same rip, same drop-in.
const SFX_DIR = MUSIC_DIR;

// Every track keyed by the slot that asks for it. The eleven floor slots ARE the theme ids in
// dungeon.js THEMES, so musicForMode() can hand a theme straight through and a new theme only
// ever needs one line added here.
//
// `resume: true` marks the floor themes, and only those. A floor theme is interrupted by every
// wild encounter, so it picks up where it left off rather than restarting — otherwise you would
// only ever hear its first few bars (see playMusic). Everything else restarts from the top, which
// is the whole point of a battle or title theme: its intro is meant to be heard.
const TRACKS = {
  // Screens and battles
  menu:      { file: '01. Pokémon Exploration Team Theme.mp3' },   // title + starter select
  wild:      { file: '15. Battle! (Wild Pokémon).mp3' },           // any wild encounter, and the catch after it
  grunt:     { file: '128. Dark Wasteland.mp3' },                  // Team Rocket grunt, end of floor
  giovanni:  { file: "68. Dialga's Fight to the Finish!.mp3" },    // Giovanni, final floor
  victory:   { file: '27. Victory! (Trainer Battle).mp3' },        // a Grunt win; one-shot fanfare
  // Giovanni's own defeat gets a different, bigger fanfare, and it OWNS the audio from that
  // moment on: playMusicExclusive() locks every later playMusic() out until the lock is released
  // when the player leaves the win screen. See the lock below.
  'victory-boss': { file: '61. Victory! (Team Galactic).mp3' },
  // The game-over screen. Like Giovanni's fanfare this one OWNS the mixer — loseRun() plays it
  // through playMusicExclusive(), so the floor or battle theme that was running when the party
  // went down is stopped and nothing can start again until the player leaves the end screen.
  lose:      { file: 'You Lose.mp3' },                             // any run ending in defeat
  // Kecleon's stall. Deliberately NOT `resume`: the shop is a place you step into, and its theme
  // is meant to start at the top every time you walk up to him, the way a shop's music does in
  // Mystery Dungeon. It is also the only track that interrupts a floor theme without a fight, so
  // the floor theme's own `resume` is what puts you back where you were on the way out.
  kecleon:   { file: "25. Kecleon's Shop.mp3" },
  // Floor themes, by theme id
  verdant:   { file: '29. Apple Woods.mp3', resume: true },              // Verdant Forest
  rocky:     { file: '90. Aegis Cave.mp3', resume: true },               // Rocky Cavern
  molten:    { file: '34. Steam Cave.mp3', resume: true },               // Molten Caldera
  frozen:    { file: '135. Vast Ice Mountain Peak.mp3', resume: true },  // Frozen Grotto
  tidepool:  { file: '12. Drenched Bluff.mp3', resume: true },           // Tidepool Grotto
  haunted:   { file: '58. Hidden Land.mp3', resume: true },              // Haunted Ruins
  warehouse: { file: '64. Temporal Tower.mp3', resume: true },           // Rocket Warehouse
  desert:    { file: '41. Quicksand Cave.mp3', resume: true },           // Scorched Desert
  swamp:     { file: '127. Barren Valley.mp3', resume: true },           // Toxic Swamp
  crystal:   { file: '43. Crystal Cave.mp3', resume: true },             // Crystal Caverns
  beach:     { file: '05. Beach Cave.mp3', resume: true },               // Sunlit Shore
};

// Music plays entirely through WebAudio (fetch -> decodeAudioData -> AudioBufferSourceNode ->
// GainNode -> destination), never through an <audio>/<video> element. On iOS an HTMLMediaElement
// is treated as "media": Safari ignores HTMLMediaElement.volume (the slider silently does
// nothing) and the OS puts a Now Playing card on the lock screen / Dynamic Island that keeps the
// track running after the app is backgrounded. WebAudio output counts as plain app sound instead
// — a GainNode gives real volume control, and suspending the AudioContext when the page is hidden
// actually halts playback, with no Now Playing UI. (Same fix as Pokemon Rumble Run.)
const XFADE = 0.08;               // seconds blended across the loop seam

const buffers = new Map();        // key -> AudioBuffer | Promise<AudioBuffer|null> | undefined
const unavailable = new Set();    // keys whose file is missing or undecodable
const nodes = new Map();          // key -> { src, gain, startedAt, offset }
const resumeAt = new Map();       // key -> seconds into the track, `resume` tracks only
let currentKey = null;
let ctx = null;
let unlocked = false;

const loopOf = (key) => (TRACKS[key] ? MUSIC_LOOPS[TRACKS[key].file] : null);

// Cut a decoded track down to just the part the game plays, and blend its loop seam.
//
// Both halves matter. These files are intro + two passes of the loop + a fade-out, so everything
// past loopEnd is dead weight: dropping it halves the PCM we hold, which is the difference between
// a floor theme costing ~30 MB and ~60 MB of memory. And because the two passes are separate
// renders rather than one repeated recording (see js/data/music-loops.js), there is no
// sample-exact splice available — wrapping loopEnd -> loopStart raw can click.
//
// The blend: playback wrapping off the end of the loop would naturally have continued into the
// audio at loopEnd, so fade that continuation into the audio at loopStart across the first XFADE
// of the loop. Both sides are the same music one loop apart, so it is a blend of like with like.
function prepare(decoded, loop) {
  if (!loop || loop.oneShot || !(loop.loopEnd > loop.loopStart)) return decoded;
  const sr = decoded.sampleRate;
  const a = Math.round(loop.loopStart * sr);
  const b = Math.min(Math.round(loop.loopEnd * sr), decoded.length);
  const x = Math.min(Math.round(XFADE * sr), decoded.length - b, b - a);
  if (b <= a) return decoded;
  const out = ctx.createBuffer(decoded.numberOfChannels, b, sr);
  for (let ch = 0; ch < decoded.numberOfChannels; ch++) {
    const src = decoded.getChannelData(ch);
    const dst = out.getChannelData(ch);
    dst.set(src.subarray(0, b));
    for (let i = 0; i < x; i++) {
      const g = 0.5 - 0.5 * Math.cos((Math.PI * i) / x);   // raised cosine
      dst[a + i] = src[b + i] * (1 - g) + src[a + i] * g;
    }
  }
  return out;
}

// Fetch + decode a track once, caching the AudioBuffer (or the in-flight promise). A missing file
// or a decode failure marks the key unavailable so every future request is an instant no-op.
function loadBuffer(key) {
  if (unavailable.has(key)) return Promise.resolve(null);
  const cached = buffers.get(key);
  if (cached) return Promise.resolve(cached);
  const track = TRACKS[key];
  if (!track || !ctx) return Promise.resolve(null);
  // The folder name has a space and the filenames carry an "e", so encode rather than trusting
  // the browser: encodeURI keeps the slashes, encodeURIComponent handles the leaf.
  const p = fetch(encodeURI(MUSIC_DIR) + encodeURIComponent(track.file))
    .then(r => { if (!r.ok) throw new Error('missing'); return r.arrayBuffer(); })
    .then(raw => ctx.decodeAudioData(raw))
    .then(decoded => {
      const ready = prepare(decoded, loopOf(key));
      buffers.set(key, ready);
      return ready;
    })
    .catch(() => { unavailable.add(key); buffers.delete(key); return null; });
  buffers.set(key, p);
  return p;
}

// How far into the track the given source has got, folded back into the loop region. ctx.currentTime
// does not advance while the context is suspended, so a track that was playing when the phone
// locked comes back at the point it stopped without any special case.
function positionOf(key) {
  const n = nodes.get(key);
  if (!n) return 0;
  const raw = n.offset + (ctx.currentTime - n.startedAt);
  const loop = loopOf(key);
  if (!loop || loop.oneShot || !(loop.loopEnd > loop.loopStart)) return raw;
  if (raw < loop.loopEnd) return raw;
  const len = loop.loopEnd - loop.loopStart;
  return loop.loopStart + ((raw - loop.loopEnd) % len);
}

function stopNode(key) {
  const n = nodes.get(key);
  if (!n) return;
  if (TRACKS[key]?.resume) resumeAt.set(key, positionOf(key));
  try { n.src.onended = null; n.src.stop(); } catch {}
  try { n.src.disconnect(); n.gain.disconnect(); } catch {}
  nodes.delete(key);
}

// Start a fresh buffer source for `key`, wired through its own gain node, and loop the measured
// region: playback runs 0 -> loopEnd once (so the intro is heard) and then wraps to loopStart
// forever, never reaching the album fade-out. One-shots just play out.
function startSource(key, buffer, offset = 0) {
  stopNode(key);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const loop = loopOf(key);
  if (loop && !loop.oneShot && loop.loopEnd > loop.loopStart) {
    src.loop = true;
    src.loopStart = loop.loopStart;
    src.loopEnd = Math.min(loop.loopEnd, buffer.duration);
  }
  const gain = ctx.createGain();
  gain.gain.value = state.settings.music;
  src.connect(gain).connect(ctx.destination);
  const at = Math.max(0, Math.min(offset, buffer.duration - 0.05));
  src.start(0, at);
  nodes.set(key, { src, gain, startedAt: ctx.currentTime, offset: at });
  if (!src.loop) src.onended = () => { if (nodes.get(key)?.src === src) nodes.delete(key); };
}

// iOS will not start any audio until a real user gesture has touched the graph. main.js calls
// this from the first pointerdown/keydown.
export function unlockAudio() {
  if (unlocked) return;
  unlocked = true;
  try {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
  } catch { ctx = null; }
  if (currentKey) playMusic(currentKey, true);
  // A wild encounter is seconds away at any moment and its theme has to land on contact, so warm
  // the tracks that get triggered mid-play rather than by walking into a screen. `lose` is one of
  // them: a party wipe lands in the middle of a battle, and it is a 263 KB jingle, not a floor
  // theme, so holding it decoded costs nothing.
  prefetchMusic('wild', 'victory', 'lose');
  // The samples are tiny next to a track, and the first stairs descent must not miss its sound
  // waiting on a decode.
  prefetchSfx();
}

// Live volume changes retarget the gain of whatever track is currently sounding.
export function applyVolumes() {
  for (const n of nodes.values()) n.gain.gain.value = state.settings.music;
}

// ---- Music -------------------------------------------------------------------------------------
// The lock exists for the two moments that END a run: Giovanni going down, and the party going
// down. Each of those tracks has to run uninterrupted on the end screen, and setMode() calls
// playMusic() on EVERY screen change, so suppressing it needs to happen here rather than by
// hunting down each caller. Both locks are released by leaving the end screen (goTitle / newRun
// in main.js).
let musicLocked = false;

// Play `key` and then bar everything else from the speakers until releaseMusicLock().
export function playMusicExclusive(key) {
  musicLocked = false;          // this one call is the one that gets through
  playMusic(key, true);
  musicLocked = true;
}

export function releaseMusicLock() { musicLocked = false; }

export function playMusic(key, force = false) {
  if (musicLocked) return;
  if (!key) { stopMusic(); return; }
  if (key === currentKey && !force) return;   // already sounding: leave it alone, do not restart
  if (currentKey && currentKey !== key) stopNode(currentKey);
  currentKey = key;
  if (!ctx || !unlocked) return;        // no file, or no gesture yet: silence, and that is fine
  loadBuffer(key).then(buf => {
    if (!buf || currentKey !== key) return;
    startSource(key, buf, TRACKS[key].resume ? (resumeAt.get(key) || 0) : 0);
  });
}

export function stopMusic() {
  if (currentKey) stopNode(currentKey);
  currentKey = null;
}

// Forget where `key` had got to, so the next playMusic() of it starts at the top of the track.
//
// This is what ARRIVING somewhere does, as opposed to coming back to it. A floor theme is
// `resume: true` precisely so that stepping out of a battle, the shop or the pause screen drops
// you back in mid-phrase where you left off — but walking onto a NEW floor, or starting a new run,
// is not coming back to anything, and picking a fresh theme up halfway through its second loop
// made every floor after the first sound like it had already been playing without you. Cheap
// enough to call unconditionally: on a track with no saved position it does nothing, and on the
// track already sounding it restarts it in place.
export function restartMusic(key) {
  if (!key) return;
  resumeAt.delete(key);
  if (key === currentKey) playMusic(key, true);
}

// Decode ahead of time so a track that is triggered by gameplay rather than by a screen change
// starts on the beat it is asked for instead of a second later.
export function prefetchMusic(...keys) {
  if (!ctx || !unlocked) return;
  for (const k of keys) if (TRACKS[k]) loadBuffer(k);
}

// Drop a decoded track. A run walks through up to eleven floor themes and each one costs tens of
// megabytes of PCM, so main.js releases a floor's theme when it leaves that floor. Never drops
// whatever is playing.
export function releaseMusic(key) {
  if (!key || key === currentKey || !buffers.has(key)) return;
  buffers.delete(key);
  resumeAt.delete(key);
}

// Backgrounding (home button / app switch / locking the phone): suspend the WebAudio clock so
// playback truly halts, then resume on return. WebAudio never shows a Now Playing card, so there
// is nothing else to keep an audio session alive in the background.
document.addEventListener('visibilitychange', () => {
  if (!ctx) return;
  if (document.hidden) { if (ctx.state === 'running') ctx.suspend(); }
  else if (unlocked && ctx.state === 'suspended') ctx.resume();
});
window.addEventListener('pagehide', () => { if (ctx && ctx.state === 'running') ctx.suspend(); });

// Which track belongs to which screen. Floors play their own theme's track, so the music changes
// with the scenery; anything not listed here (glossary, settings, dex, the end screen) keeps
// whatever was already playing — which is what lets the end screen carry whichever run-ending
// track already holds the lock: the victory fanfare on a win, You Lose on a defeat.
export function musicForMode(mode, { themeId = null, battleKind = null } = {}) {
  switch (mode) {
    case 'title':
    case 'mode':
    case 'starter':
      return 'menu';
    case 'playing':
    case 'pause':
    case 'bag':
    case 'swap':
      return themeId && TRACKS[themeId] ? themeId : currentKey;
    case 'battle':
      if (battleKind === 'giovanni') return 'giovanni';
      if (battleKind === 'grunt') return 'grunt';
      return 'wild';
    case 'catch':
      return 'wild';                    // the minigame follows straight on from a wild encounter
    case 'shop':
      return 'kecleon';
    default:
      return currentKey;
  }
}

// ---- SFX samples ------------------------------------------------------------------------------
// A handful of effects have a real recording sitting next to the music. Where one exists it
// REPLACES the synthesized version of the same name; where it does not, the synth still plays, so
// no effect is ever silent. Same folder as the music — these are game rips, not generated assets.
// The two jingles are mp3s rather than wavs and that changes nothing — decodeAudioData takes
// either. Both are short enough to be effects rather than music (Evolution 1.28 s, Pokemon Joins
// 1.53 s), which is why they live here and ride the SFX slider instead of the music one.
const SFX_FILES = {
  stairs: 'SE_ACT_STAIRS_DOWN.wav',
  evolve: '213. Evolution.mp3',
  join:   '208. Pokémon Joins.mp3',
  money:  'SE_ACT_MONEY.wav',
};

const sfxBuffers = new Map();     // name -> AudioBuffer once decoded
const sfxMissing = new Set();     // names whose file is missing or undecodable

function loadSfxSample(name) {
  const file = SFX_FILES[name];
  if (!file || !ctx || sfxMissing.has(name) || sfxBuffers.has(name)) return;
  sfxMissing.add(name);           // provisional: cleared on success, so one in-flight load only
  fetch(encodeURI(SFX_DIR) + encodeURIComponent(file))
    .then(r => { if (!r.ok) throw new Error('missing'); return r.arrayBuffer(); })
    .then(raw => ctx.decodeAudioData(raw))
    .then(buf => { sfxBuffers.set(name, buf); sfxMissing.delete(name); })
    .catch(() => { /* stays in sfxMissing: the synth version covers it forever */ });
}

// Decode every sample up front, on the same gesture that unlocks the context. Without this the
// first stairs descent of a run would fall through to the synth while the file was still decoding.
export function prefetchSfx() {
  for (const name of Object.keys(SFX_FILES)) loadSfxSample(name);
}

// Returns true only if a decoded sample actually started, so sfx() knows whether to fall back.
function playSample(name) {
  const buf = sfxBuffers.get(name);
  if (!buf || !ctx || state.settings.sfx <= 0) {
    loadSfxSample(name);          // no-op unless this is a sample we have not fetched yet
    return false;
  }
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const g = ctx.createGain();
  g.gain.value = state.settings.sfx;
  src.connect(g).connect(ctx.destination);
  src.start(0);
  return true;
}

// ---- SFX (synthesized) -------------------------------------------------------------------------
// One tiny helper covers everything: an oscillator through a gain envelope, optionally swept.
function tone({ freq = 440, endFreq = null, dur = 0.12, type = 'square', gain = 0.25, delay = 0 }) {
  if (!ctx || state.settings.sfx <= 0) return;
  const t0 = ctx.currentTime + delay;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (endFreq) osc.frequency.exponentialRampToValueAtTime(Math.max(20, endFreq), t0 + dur);
  const peak = gain * state.settings.sfx;
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(peak, t0 + Math.min(0.02, dur * 0.3));
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

function noise({ dur = 0.18, gain = 0.2, delay = 0, filterHz = 1200 }) {
  if (!ctx || state.settings.sfx <= 0) return;
  const t0 = ctx.currentTime + delay;
  const frames = Math.floor(ctx.sampleRate * dur);
  const buf = ctx.createBuffer(1, frames, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < frames; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / frames);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const filt = ctx.createBiquadFilter();
  filt.type = 'lowpass';
  filt.frequency.value = filterHz;
  const g = ctx.createGain();
  g.gain.value = gain * state.settings.sfx;
  src.connect(filt).connect(g).connect(ctx.destination);
  src.start(t0);
}

export function sfx(name) {
  if (!ctx) return;
  // A real recording wins over the synthesized stand-in for the same name. Everything below is
  // the fallback, which is what still plays if the .wav is not on the server.
  if (SFX_FILES[name] && playSample(name)) return;
  switch (name) {
    case 'select':   tone({ freq: 660, dur: 0.07, gain: 0.18 }); break;
    case 'confirm':  tone({ freq: 520, endFreq: 990, dur: 0.16, type: 'triangle', gain: 0.24 }); break;
    case 'back':     tone({ freq: 400, endFreq: 240, dur: 0.12, type: 'triangle', gain: 0.2 }); break;
    case 'pickup':   tone({ freq: 880, dur: 0.07, gain: 0.2 });
                     tone({ freq: 1320, dur: 0.1, gain: 0.18, delay: 0.07 }); break;
    // Only the fallback: SE_ACT_MONEY.wav in SFX_FILES is what actually plays on a coin. Two
    // bright metallic pings a hair apart, so a coin never sounds like a plain 'pickup'.
    case 'money':    tone({ freq: 1560, dur: 0.06, type: 'triangle', gain: 0.2 });
                     tone({ freq: 2340, dur: 0.09, type: 'triangle', gain: 0.16, delay: 0.05 }); break;
    // Buying something from Kecleon: the money ping is the sample, this is the till closing after.
    case 'buy':      tone({ freq: 700, endFreq: 1400, dur: 0.12, type: 'triangle', gain: 0.22 });
                     tone({ freq: 1050, dur: 0.14, type: 'triangle', gain: 0.18, delay: 0.1 }); break;
    case 'hit':      noise({ dur: 0.14, gain: 0.22, filterHz: 900 });
                     tone({ freq: 220, endFreq: 110, dur: 0.12, gain: 0.16 }); break;
    case 'superhit': noise({ dur: 0.2, gain: 0.28, filterHz: 1800 });
                     tone({ freq: 330, endFreq: 120, dur: 0.2, gain: 0.22 });
                     tone({ freq: 990, dur: 0.09, gain: 0.16, delay: 0.04 }); break;
    case 'faint':    tone({ freq: 440, endFreq: 90, dur: 0.5, type: 'sawtooth', gain: 0.22 }); break;
    case 'encounter':tone({ freq: 200, endFreq: 620, dur: 0.28, type: 'sawtooth', gain: 0.24 }); break;
    case 'throw':    noise({ dur: 0.12, gain: 0.16, filterHz: 2400 }); break;
    // A curveball gets its own whoosh — a rising filtered hiss over the plain throw noise, so
    // you hear that the spin took before you see the ball bend.
    case 'curve':    noise({ dur: 0.22, gain: 0.18, filterHz: 1400 });
                     tone({ freq: 300, endFreq: 900, dur: 0.22, type: 'sine', gain: 0.12 }); break;
    case 'deflect':  noise({ dur: 0.16, gain: 0.26, filterHz: 700 });
                     tone({ freq: 180, endFreq: 70, dur: 0.22, type: 'square', gain: 0.18 }); break;
    // The three throw grades, each one note higher and brighter than the last.
    case 'nice':     tone({ freq: 784, dur: 0.1, type: 'triangle', gain: 0.2 }); break;
    case 'great':    [784, 988].forEach((f, i) =>
                       tone({ freq: f, dur: 0.11, type: 'triangle', gain: 0.22, delay: i * 0.08 })); break;
    case 'excellent':[784, 988, 1319].forEach((f, i) =>
                       tone({ freq: f, dur: 0.13, type: 'triangle', gain: 0.24, delay: i * 0.08 })); break;
    case 'wobble':   tone({ freq: 300, dur: 0.06, gain: 0.16, type: 'sine' }); break;
    // The capture beat, in three parts. The ball swallowing the Pokemon is a downward swoop, each
    // shake is a dull knock, and the LOCK is the hard bright click that means it is yours — that
    // click is the moment of the catch and it lands before the fanfare does.
    case 'absorb':   tone({ freq: 900, endFreq: 220, dur: 0.34, type: 'sine', gain: 0.2 });
                     noise({ dur: 0.3, gain: 0.12, filterHz: 1200 }); break;
    // A shake is a dull muffled knock — something moving around INSIDE a closed shell. It has to
    // sit clearly below the lock, because the whole point of the wobble is waiting to find out
    // which of the two sounds you are going to get.
    case 'shake':    tone({ freq: 205, endFreq: 148, dur: 0.12, type: 'square', gain: 0.16 });
                     noise({ dur: 0.09, gain: 0.1, filterHz: 480 }); break;
    // The lock is the catch. Hard mechanical CLICK, then a bright three-note shimmer ringing off
    // it — deliberately nothing like the knocks that came before.
    case 'lock':     noise({ dur: 0.05, gain: 0.3, filterHz: 6000 });
                     tone({ freq: 2100, dur: 0.04, type: 'square', gain: 0.28 });
                     tone({ freq: 1500, endFreq: 1950, dur: 0.08, type: 'square', gain: 0.2, delay: 0.045 });
                     [1319, 1760, 2637].forEach((f, i) =>
                       tone({ freq: f, dur: 0.3, type: 'sine', gain: 0.17, delay: 0.1 + i * 0.035 })); break;
    // Held back 0.42 s so the lock's click lands ALONE first and the fanfare answers it. Played on
    // top of each other they smear into one noise and the moment of the catch is lost.
    case 'caught':   [523, 659, 784, 1047].forEach((f, i) =>
                       tone({ freq: f, dur: 0.13, type: 'triangle', gain: 0.22, delay: 0.42 + i * 0.1 })); break;
    case 'broke':    tone({ freq: 500, endFreq: 180, dur: 0.3, type: 'square', gain: 0.2 }); break;
    // A new team member. Only the fallback: '208. Pokémon Joins.mp3' is what actually plays.
    case 'join':     [659, 880, 1047, 1319].forEach((f, i) =>
                       tone({ freq: f, dur: 0.14, type: 'triangle', gain: 0.2, delay: i * 0.11 })); break;
    // Only the fallback: '213. Evolution.mp3' in SFX_FILES is what actually plays.
    case 'evolve':   [392, 523, 659, 784, 1047].forEach((f, i) =>
                       tone({ freq: f, dur: 0.16, type: 'sine', gain: 0.2, delay: i * 0.12 })); break;
    // A Revive used to borrow 'evolve'. It cannot any more: 'evolve' is now the real Evolution
    // jingle, and hearing a Pokemon evolve every time one is pulled back from the brink is a lie
    // about what just happened. This is the rising arpeggio the old synth evolve used to be,
    // three notes instead of five so it stays an in-battle beat rather than a fanfare.
    case 'revive':   [523, 659, 880].forEach((f, i) =>
                       tone({ freq: f, dur: 0.15, type: 'sine', gain: 0.2, delay: i * 0.1 })); break;
    // Chansey's rest stop. Deliberately NOT 'revive' or 'victory': it is a whole party coming back
    // to full at once, so it wants to be broader than a single Pokemon's arpeggio and softer than
    // a fanfare — a rising major triad plus its octave, on sine, overlapping rather than stepped.
    case 'heal':     [523, 659, 784, 1047].forEach((f, i) =>
                       tone({ freq: f, dur: 0.42, type: 'sine', gain: 0.16, delay: i * 0.07 })); break;
    case 'stairs':   [659, 880].forEach((f, i) =>
                       tone({ freq: f, dur: 0.18, type: 'triangle', gain: 0.22, delay: i * 0.14 })); break;
    case 'victory':  [523, 659, 784, 1047, 1319].forEach((f, i) =>
                       tone({ freq: f, dur: 0.2, type: 'triangle', gain: 0.24, delay: i * 0.14 })); break;
    case 'defeat':   [392, 330, 262, 196].forEach((f, i) =>
                       tone({ freq: f, dur: 0.32, type: 'sawtooth', gain: 0.22, delay: i * 0.22 })); break;
    default: break;
  }
}
