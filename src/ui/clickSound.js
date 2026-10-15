// Short mechanical click via Web Audio. Off until setClickSoundEnabled(true).
// No sample files and no audio library.

let context = null;
let enabled = false;

export function setClickSoundEnabled(on) {
    enabled = Boolean(on);
}

export function isClickSoundEnabled() {
    return enabled;
}

function audioContext() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    if (!context) context = new Ctx();
    return context;
}

function tone(ctx) {
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    const filter = ctx.createBiquadFilter();
    const gain = ctx.createGain();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(540, t);
    osc.frequency.exponentialRampToValueAtTime(160, t + 0.04);
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(1600, t);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.045, t + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.055);
    osc.connect(filter);
    filter.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t);
    osc.stop(t + 0.06);
}

export function playClick() {
    if (!enabled) return;
    const ctx = audioContext();
    if (!ctx) return;
    if (ctx.state === "suspended") {
        ctx.resume()
            .then(() => tone(ctx))
            .catch(() => {});
        return;
    }
    tone(ctx);
}
