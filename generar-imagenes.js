require('dotenv').config();
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const API_KEY  = process.env.KIE_API_KEY;
const IMG_DIR  = path.join(__dirname, 'images');
if (!fs.existsSync(IMG_DIR)) fs.mkdirSync(IMG_DIR);

const SERVICES = [
  {
    file: 'consulta-express.jpg',
    prompt: 'Professional certified cosmetologist woman on a modern video call consultation about skincare, laptop open, skincare products on desk, bright clean modern clinic, warm natural lighting, photorealistic high quality portrait photography'
  },
  {
    file: 'asesoria-personalizada.jpg',
    prompt: 'Latin woman with beautiful glowing skin in a professional skincare consultation session, cosmetologist taking notes, personalized routine products on table, warm clinic environment, natural light, photorealistic lifestyle photography'
  },
  {
    file: 'revision-productos.jpg',
    prompt: 'Elegant professional hands reviewing skincare product ingredients list, premium bottles and serums on white marble surface, clean minimal flat lay, beauty professional analyzing products, photorealistic high quality product photography'
  }
];

function request(method, url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = {
      hostname: u.hostname, path: u.pathname + u.search,
      method, headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' }
    };
    const req = https.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(JSON.parse(data)));
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        return download(res.headers.location, dest).then(resolve).catch(reject);
      }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', reject);
  });
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function poll(taskId) {
  for (let i = 0; i < 30; i++) {
    await sleep(4000);
    const r = await request('GET', `https://api.kie.ai/api/v1/gpt4o-image/record-info?taskId=${taskId}`);
    const s = r?.data?.status;
    process.stdout.write(`  estado: ${s}\r`);
    if (s === 'SUCCESS')         return r.data.response.resultUrls[0];
    if (s?.includes('FAILED'))   throw new Error('Generación fallida: ' + (r.data.errorMessage || s));
  }
  throw new Error('Timeout esperando imagen');
}

(async () => {
  console.log('\n🎨 Generando imágenes con kie.ai...\n');
  for (const svc of SERVICES) {
    console.log(`→ ${svc.file}`);
    const res = await request('POST', 'https://api.kie.ai/api/v1/gpt4o-image/generate', {
      prompt: svc.prompt, size: '1:1'
    });
    if (res.code !== 200) throw new Error('Error al crear tarea: ' + JSON.stringify(res));
    const taskId = res.data.taskId;
    console.log(`  taskId: ${taskId}`);
    const imgUrl = await poll(taskId);
    console.log(`  ✓ Descargando...`);
    await download(imgUrl, path.join(IMG_DIR, svc.file));
    console.log(`  ✓ Guardada: images/${svc.file}\n`);
  }
  console.log('✅ Todas las imágenes generadas en /images\n');
})().catch(err => { console.error('\n✗ Error:', err.message); process.exit(1); });
