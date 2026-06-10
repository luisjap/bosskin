/* ════════════════════════════════════════════════════════════════════════════
   editor-render.js — Render de video con FFmpeg NATIVO (servidor)
   Corta silencios (split+trim+concat → A/V sincronizado), quema subtítulos
   animados (ASS/libass) y aplica efectos. Confiable, a diferencia de wasm.
   ════════════════════════════════════════════════════════════════════════════ */
const { spawn } = require('child_process');
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const crypto = require('crypto');

// ── Mapa de tiempo original → tiempo de salida (tras cortar) ──────────────────
function buildTimeMap(kept) {
  let accum = 0;
  return kept.map(seg => {
    const entry = { origStart: seg.start, origEnd: seg.end, newStart: accum };
    accum += seg.end - seg.start;
    return entry;
  });
}
function remap(origTime, map, speed) {
  for (const e of map) {
    if (origTime >= e.origStart && origTime <= e.origEnd) {
      return (e.newStart + (origTime - e.origStart)) / speed;
    }
  }
  let best = -1;
  for (const e of map) {
    if (origTime > e.origEnd) best = (e.newStart + (e.origEnd - e.origStart)) / speed;
  }
  return best;
}

function assTime(s) {
  if (s < 0) s = 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const cs = Math.round((s % 1) * 100);
  return `${h}:${String(m).padStart(2,'0')}:${String(sec).padStart(2,'0')}.${String(cs).padStart(2,'0')}`;
}
function escAss(t) {
  return String(t).replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}').replace(/\n/g, ' ');
}
function rgbToAss(hex) {
  const h = String(hex || 'FFFFFF').replace('#', '').padStart(6, '0');
  const r = h.slice(0,2), g = h.slice(2,4), b = h.slice(4,6);
  return `&H00${b}${g}${r}`.toUpperCase();
}

// ── Genera subtítulos ASS animados palabra por palabra ────────────────────────
function buildASS(kept, effects, vw, vh) {
  const speed = effects.speed || 1.0;
  const style = effects.subtitleStyle || 'tiktok';
  const timeMap = buildTimeMap(kept);
  // Tamaño y márgenes relativos al ancho real del video (vertical = angosto)
  const fontSize = Math.round(vw * (style === 'minimal' ? 0.05 : 0.058));
  const marginV  = Math.round(vh * 0.16);
  const marginLR = Math.round(vw * 0.05);   // margen lateral pequeño
  const outline  = Math.max(2, Math.round(fontSize * 0.08));
  const hi = rgbToAss(effects.highlightColor);

  // WrapStyle 0 = ajuste de línea inteligente (el texto largo baja de línea
  // en vez de salirse por los costados). Fuente Liberation Sans (instalada).
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${vw}
PlayResY: ${vh}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Main,Liberation Sans,${fontSize},&H00FFFFFF,&H000000FF,&H00101010,&H64000000,-1,0,0,0,100,100,0,0,1,${outline},2,2,${marginLR},${marginLR},${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text`;

  const events = [];
  for (const seg of kept) {
    if (seg.type !== 'speech' || !Array.isArray(seg.words) || !seg.words.length) continue;
    const words = seg.words;

    if (style === 'minimal') {
      const s = remap(seg.start, timeMap, speed);
      const e = remap(seg.end, timeMap, speed);
      if (s < 0 || e <= s) continue;
      events.push(`Dialogue: 0,${assTime(s)},${assTime(e)},Main,,0,0,0,,{\\fad(80,80)}${escAss(seg.text)}`);
      continue;
    }

    for (let j = 0; j < words.length; j++) {
      const w = words[j];
      const s = remap(w.start, timeMap, speed);
      let e = remap(j + 1 < words.length ? words[j + 1].start : w.end, timeMap, speed);
      if (s < 0) continue;
      if (e <= s) e = s + 0.18;

      const line = words.map((ww, k) => {
        const t = escAss(ww.text);
        if (k === j) {
          return style === 'bold-color'
            ? `{\\c${hi}\\fscx108\\fscy108}${t}{\\r}`
            : `{\\fscx108\\fscy108}${t}{\\r}`;
        }
        return style === 'bold-color' ? `{\\alpha&H40&}${t}{\\r}` : t;
      }).join(' ');

      events.push(`Dialogue: 0,${assTime(s)},${assTime(e)},Main,,0,0,0,,${line}`);
    }
  }
  return `${header}\n${events.join('\n')}\n`;
}

// ── Construye el filter_complex ───────────────────────────────────────────────
function evenExpr(e) { return `trunc(${e}/2)*2`; }

function buildFilterComplex(kept, effects, vw, vh, assPath) {
  const speed = effects.speed || 1.0;
  const n = kept.length;
  const parts = [];

  const vSplit = kept.map((_, i) => `[vs${i}]`).join('');
  const aSplit = kept.map((_, i) => `[as${i}]`).join('');
  parts.push(`[0:v]split=${n}${vSplit}`);
  parts.push(`[0:a]asplit=${n}${aSplit}`);

  // fps=30 fuerza frame rate constante en cada segmento. Sin esto, los videos
  // VFR (WhatsApp/celular) se desfasan: el video se estira y el audio no.
  kept.forEach((s, i) => {
    const st = s.start.toFixed(3), en = s.end.toFixed(3);
    parts.push(`[vs${i}]trim=start=${st}:end=${en},setpts=PTS-STARTPTS,fps=30[v${i}]`);
    parts.push(`[as${i}]atrim=start=${st}:end=${en},asetpts=PTS-STARTPTS[a${i}]`);
  });

  const concatIn = kept.map((_, i) => `[v${i}][a${i}]`).join('');
  parts.push(`${concatIn}concat=n=${n}:v=1:a=1[cv][ca]`);

  // Video
  const vChain = [];
  if (speed !== 1.0) vChain.push(`setpts=${(1 / speed).toFixed(4)}*PTS`);
  if (effects.zoomBreath) {
    vChain.push(`zoompan=z='1.05+0.025*sin(on/42)':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${vw}x${vh}:fps=30`);
  } else if (effects.punchIn) {
    vChain.push('scale=trunc(iw*1.07/2)*2:trunc(ih*1.07/2)*2');
    vChain.push(`crop=${evenExpr('iw/1.07')}:${evenExpr('ih/1.07')}`);
  }
  if (effects.warmGrade) {
    vChain.push('eq=brightness=0.04:contrast=1.06:saturation=1.18');
    vChain.push('colorbalance=rs=0.06:bs=-0.08:rm=0.04:bm=-0.04');
  }
  if (effects.contrast) {
    vChain.push(effects.warmGrade ? 'unsharp=3:3:0.4' : 'eq=contrast=1.08:saturation=1.08,unsharp=3:3:0.5');
  }
  if (effects.vignette) vChain.push('vignette=PI/5');
  if (assPath) {
    // Escapar la ruta para el filtro ass (: y \ y ')
    const safe = assPath.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
    vChain.push(`ass='${safe}'`);
  }
  vChain.push('format=yuv420p');
  parts.push(`[cv]${vChain.join(',')}[vout]`);

  // Audio — aresample asegura sincronía; dynaudnorm normaliza sin riesgo de
  // silenciar (loudnorm en una pasada a veces dejaba el audio mudo).
  const aChain = ['aresample=async=1:first_pts=0'];
  if (speed !== 1.0) {
    aChain.push(speed <= 2.0 ? `atempo=${speed}` : `atempo=2.0,atempo=${(speed / 2).toFixed(3)}`);
  }
  if (effects.loudnorm) aChain.push('dynaudnorm=f=200:g=15');
  parts.push(`[ca]${aChain.join(',')}[aout]`);

  return parts.join(';');
}

function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    ff.stderr.on('data', d => { stderr += d.toString(); if (stderr.length > 20000) stderr = stderr.slice(-20000); });
    ff.on('error', err => reject(new Error(`No se pudo ejecutar ffmpeg: ${err.message}`)));
    ff.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg salió con código ${code}\n${stderr.slice(-1500)}`)));
  });
}

/**
 * Renderiza el video final.
 * @returns {Promise<string>} ruta del MP4 generado (el caller debe borrarlo)
 */
async function renderVideo({ inputPath, segments, effects, vw, vh }) {
  const kept = (segments || [])
    .filter(s => s && s.keep && typeof s.start === 'number' && typeof s.end === 'number' && s.end > s.start)
    .sort((a, b) => a.start - b.start);
  if (!kept.length) throw new Error('No hay segmentos para procesar');

  vw = vw || 1080; vh = vh || 1920;
  const eff = effects || {};
  const useSubs = eff.subtitleStyle && eff.subtitleStyle !== 'none';

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bosskin-'));
  const assPath = path.join(work, 'subs.ass');
  const outPath = path.join(work, 'output.mp4');

  try {
    if (useSubs) fs.writeFileSync(assPath, buildASS(kept, eff, vw, vh));

    const filter = buildFilterComplex(kept, eff, vw, vh, useSubs ? assPath : null);
    const baseArgs = [
      '-y', '-i', inputPath,
      '-filter_complex', filter,
      '-map', '[vout]', '-map', '[aout]',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p',
      '-r', '30',
      '-c:a', 'aac', '-b:a', '160k', '-ac', '2',
      '-movflags', '+faststart',
      outPath,
    ];
    console.log(`[editor] render: ${kept.length} segmentos, subs=${useSubs}, ${vw}x${vh}`);

    try {
      await runFFmpeg(baseArgs);
    } catch (err) {
      // Reintento sin subtítulos por si libass fallara
      if (useSubs) {
        const filterNoSubs = buildFilterComplex(kept, eff, vw, vh, null);
        const retry = [...baseArgs];
        retry[retry.indexOf('-filter_complex') + 1] = filterNoSubs;
        await runFFmpeg(retry);
      } else {
        throw err;
      }
    }

    if (!fs.existsSync(outPath)) throw new Error('No se generó el video de salida');
    return { outPath, work };
  } catch (e) {
    try { fs.rmSync(work, { recursive: true, force: true }); } catch {}
    throw e;
  }
}

module.exports = { renderVideo };
