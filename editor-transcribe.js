/* ════════════════════════════════════════════════════════════════════════════
   editor-transcribe.js — Transcripción con Groq Whisper large-v3 (servidor)
   Extrae el audio con FFmpeg y lo envía a la API de Groq (gratis, rápida,
   calidad large-v3). Devuelve palabras con timestamps.
   ════════════════════════════════════════════════════════════════════════════ */
const { spawn } = require('child_process');
const fs   = require('fs');
const path = require('path');

const GROQ_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';

// Extrae el audio a MP3 mono 16kHz (archivo pequeño, ideal para la API)
function extractAudio(inputPath, audioPath) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', [
      '-y', '-i', inputPath,
      '-vn', '-ac', '1', '-ar', '16000', '-b:a', '64k',
      audioPath,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    ff.stderr.on('data', d => { err += d.toString(); if (err.length > 8000) err = err.slice(-8000); });
    ff.on('error', e => reject(new Error(`No se pudo ejecutar ffmpeg: ${e.message}`)));
    ff.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg (audio) salió con código ${code}\n${err.slice(-800)}`)));
  });
}

/**
 * Transcribe un video con Groq. Devuelve { words: [{text,start,end}], duration }.
 */
async function transcribeWithGroq(videoPath) {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error('Falta configurar GROQ_API_KEY en el servidor (consíguela gratis en console.groq.com).');
  }

  const audioPath = videoPath + '.mp3';
  try {
    await extractAudio(videoPath, audioPath);

    const stat = fs.statSync(audioPath);
    if (stat.size > 24 * 1024 * 1024) {
      throw new Error('El audio supera el límite de 25MB de Groq. Usa un video más corto.');
    }

    const buf = fs.readFileSync(audioPath);
    const form = new FormData();
    form.append('model', 'whisper-large-v3');
    form.append('language', 'es');
    form.append('response_format', 'verbose_json');
    form.append('timestamp_granularities[]', 'word');
    form.append('file', new Blob([buf], { type: 'audio/mpeg' }), 'audio.mp3');

    const resp = await fetch(GROQ_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });

    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      throw new Error(`Groq respondió ${resp.status}: ${txt.slice(0, 300)}`);
    }

    const data = await resp.json();

    // verbose_json con granularidad de palabra → data.words
    let words = [];
    if (Array.isArray(data.words) && data.words.length) {
      words = data.words.map(w => ({
        text: String(w.word ?? w.text ?? '').trim(),
        start: Number(w.start) || 0,
        end: Number(w.end) || (Number(w.start) || 0) + 0.3,
      })).filter(w => w.text);
    } else if (Array.isArray(data.segments)) {
      // Fallback: usar segmentos si no hay palabras
      words = data.segments.map(s => ({
        text: String(s.text ?? '').trim(),
        start: Number(s.start) || 0,
        end: Number(s.end) || 0,
      })).filter(w => w.text);
    }

    if (!words.length) throw new Error('Groq no devolvió texto. ¿El video tiene voz audible?');

    return { words, duration: Number(data.duration) || 0 };
  } finally {
    try { fs.unlinkSync(audioPath); } catch {}
  }
}

module.exports = { transcribeWithGroq };
