// Two independent audio systems with independent volume sliders in Settings:
//
//   SFX   — fully synthesized with WebAudio. No files needed, so sound effects always work.
//   MUSIC — the user-supplied Explorers of Sky mp3s named in assets/music/README.txt.
//
// A MISSING MUSIC FILE IS SILENCE, NOT AN ERROR. The mp3s are dropped in later; every track is
// probed once, a failure marks it unavailable, and the game carries on. Never gate anything on a
// track existing.
import { state } from './state.js';

const MUSIC_DIR = 'assets/music/';
const TRACKS = {
  title: 'title.mp3',
  starter: 'starter-select.mp3',
  dungeon: 'dungeon.mp3',
  dungeonAlt: 'dungeon-alt.mp3',
  battle: 'battle.mp3',
  boss: 'boss.mp3',
  catch: 'catch.mp3',
  victory: 'victory.mp3',
  gameOver: 'game-over.mp3',
};

const elements = new Map();       // key -> HTMLAudioElement
const unavailable = new Set();    // keys whose file is missing or unplayable
let currentKey = null;
let ctx = null;
let unlocked = false;

function element(key) {
  if (unavailable.has(key)) return null;
  if (elements.has(key)) return elements.get(key);
  const file = TRACKS[key];
  if (!file) return null;
  const el = new Audio(MUSIC_DIR + file);
  el.preload = 'auto';
  el.loop = true;
  el.volume = 0;
  // The only signal that a file was never dropped in. Mark it and stop trying.
  el.addEventListener('error', () => {
    unavailable.add(key);
    elements.delete(key);
    if (currentKey === key) currentKey = null;
  });
  elements.set(key, el);
  return el;
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
}

export function applyVolumes() {
  const el = currentKey ? elements.get(currentKey) : null;
  if (el) el.volume = state.settings.music;
}

// ---- Music -------------------------------------------------------------------------------------
export function playMusic(key, force = false) {
  if (!key) { stopMusic(); return; }
  if (key === currentKey && !force) return;
  if (currentKey && currentKey !== key) {
    const prev = elements.get(currentKey);
    if (prev) { prev.pause(); prev.currentTime = 0; }
  }
  currentKey = key;
  const el = element(key);
  if (!el || !unlocked) return;         // no file, or no gesture yet: silence, and that is fine
  el.volume = state.settings.music;
  el.loop = true;
  const p = el.play();
  if (p && p.catch) p.catch(() => { /* autoplay refused; the next gesture retries */ });
}

export function stopMusic() {
  if (currentKey) {
    const el = elements.get(currentKey);
    if (el) { el.pause(); el.currentTime = 0; }
  }
  currentKey = null;
}

// One-shot jingle over the top of whatever is looping (floor clear, successful catch).
export function playJingle(key = 'victory') {
  const el = element(key);
  if (!el || !unlocked) return;
  const one = el.cloneNode();
  one.loop = false;
  one.volume = state.settings.music;
  const p = one.play();
  if (p && p.catch) p.catch(() => {});
}

// Which loop belongs to which screen. Floor themes alternate between the two exploration loops so
// a five-floor run does not sit on one track the whole way down.
export function musicForMode(mode, { floorIndex = 0, boss = false } = {}) {
  switch (mode) {
    case 'title': return 'title';
    case 'starter': return 'starter';
    case 'playing':
    case 'paused':
    case 'bag':
      return floorIndex % 2 === 0 ? 'dungeon' : 'dungeonAlt';
    case 'battle': return boss ? 'boss' : 'battle';
    case 'catch': return 'catch';
    case 'gameover': return 'gameOver';
    default: return currentKey;
  }
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
  switch (name) {
    case 'select':   tone({ freq: 660, dur: 0.07, gain: 0.18 }); break;
    case 'confirm':  tone({ freq: 520, endFreq: 990, dur: 0.16, type: 'triangle', gain: 0.24 }); break;
    case 'back':     tone({ freq: 400, endFreq: 240, dur: 0.12, type: 'triangle', gain: 0.2 }); break;
    case 'pickup':   tone({ freq: 880, dur: 0.07, gain: 0.2 });
                     tone({ freq: 1320, dur: 0.1, gain: 0.18, delay: 0.07 }); break;
    case 'hit':      noise({ dur: 0.14, gain: 0.22, filterHz: 900 });
                     tone({ freq: 220, endFreq: 110, dur: 0.12, gain: 0.16 }); break;
    case 'superhit': noise({ dur: 0.2, gain: 0.28, filterHz: 1800 });
                     tone({ freq: 330, endFreq: 120, dur: 0.2, gain: 0.22 });
                     tone({ freq: 990, dur: 0.09, gain: 0.16, delay: 0.04 }); break;
    case 'faint':    tone({ freq: 440, endFreq: 90, dur: 0.5, type: 'sawtooth', gain: 0.22 }); break;
    case 'encounter':tone({ freq: 200, endFreq: 620, dur: 0.28, type: 'sawtooth', gain: 0.24 }); break;
    case 'throw':    noise({ dur: 0.12, gain: 0.16, filterHz: 2400 }); break;
    case 'wobble':   tone({ freq: 300, dur: 0.06, gain: 0.16, type: 'sine' }); break;
    case 'caught':   [523, 659, 784, 1047].forEach((f, i) =>
                       tone({ freq: f, dur: 0.13, type: 'triangle', gain: 0.22, delay: i * 0.1 })); break;
    case 'broke':    tone({ freq: 500, endFreq: 180, dur: 0.3, type: 'square', gain: 0.2 }); break;
    case 'evolve':   [392, 523, 659, 784, 1047].forEach((f, i) =>
                       tone({ freq: f, dur: 0.16, type: 'sine', gain: 0.2, delay: i * 0.12 })); break;
    case 'stairs':   [659, 880].forEach((f, i) =>
                       tone({ freq: f, dur: 0.18, type: 'triangle', gain: 0.22, delay: i * 0.14 })); break;
    case 'victory':  [523, 659, 784, 1047, 1319].forEach((f, i) =>
                       tone({ freq: f, dur: 0.2, type: 'triangle', gain: 0.24, delay: i * 0.14 })); break;
    case 'defeat':   [392, 330, 262, 196].forEach((f, i) =>
                       tone({ freq: f, dur: 0.32, type: 'sawtooth', gain: 0.22, delay: i * 0.22 })); break;
    default: break;
  }
}
