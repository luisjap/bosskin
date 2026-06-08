require('dotenv').config();
const express      = require('express');
const cors         = require('cors');
const helmet       = require('helmet');
const rateLimit    = require('express-rate-limit');
const multer       = require('multer');
const path         = require('path');
const fs           = require('fs');
const crypto       = require('crypto');
const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');
const { Resend }   = require('resend');

/* ── Validar variables de entorno ─────────────────────────────────────────── */
const REQUIRED_ENV = ['ADMIN_PASSWORD'];
const missing = REQUIRED_ENV.filter(k => !process.env[k]);
if (missing.length) { console.error(`\n✗ Variables de entorno faltantes: ${missing.join(', ')}\n`); process.exit(1); }

const app      = express();
const PORT     = process.env.PORT || 3004;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const DATA_DIR = process.env.DATA_DIR || __dirname;
const DB_FILE      = path.join(DATA_DIR, 'bookings.json');
const BL_FILE      = path.join(DATA_DIR, 'blocked.json');
const CFG_FILE     = path.join(DATA_DIR, 'config.json');
const CONTENT_FILE = path.join(DATA_DIR, 'content.json');

const resend   = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const mpClient = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN || '' });

/* ── Sesiones admin (token en memoria, expiran en 24h) ───────────────────── */
const sessions = new Map(); // token → expiry timestamp
setInterval(() => {
  const now = Date.now();
  sessions.forEach((exp, tok) => { if (exp < now) sessions.delete(tok); });
}, 3_600_000);

/* ── Helpers ──────────────────────────────────────────────────────────────── */
const escHtml = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

function parseCookie(req, name) {
  const raw = req.headers.cookie?.split(';').map(c => c.trim()).find(c => c.startsWith(name + '='));
  return raw ? decodeURIComponent(raw.slice(name.length + 1)) : null;
}

/* ── Config y content ─────────────────────────────────────────────────────── */
const DEFAULT_CONFIG = {
  services: [
    { key:'express',  name:'Consulta Express',       price:6500,  duration:25, active:true, description:'Sesión de 25 minutos para resolver tus dudas puntuales.', features:['25 min de sesión online','Respuesta en 24 horas','Pago previo confirmado'] },
    { key:'asesoria', name:'Asesoría Personalizada', price:20000, duration:60, active:true, description:'Sesión de 60 minutos donde analizamos tu piel en profundidad.', features:['60 min de sesión completa','Rutina completa por escrito','Lista de productos reales','Seguimiento incluido'] },
    { key:'revision', name:'Revisión de Productos',  price:10000, duration:20, active:true, description:'Revisamos los productos que ya tienes o planeas comprar.', features:['20 minutos de sesión','Hasta 10 productos revisados','Análisis de ingredientes'] },
  ],
  schedule: { slots:['11:00','12:00','13:00','14:00','15:00','16:00','17:00','18:00','19:00'], workdays:[1,2,3,4,5], minAdvanceHours:2, maxAdvanceDays:60 },
};

function readConfig() {
  const src = fs.existsSync(CFG_FILE) ? CFG_FILE : path.join(__dirname, 'config.json');
  try { return JSON.parse(fs.readFileSync(src, 'utf8')); } catch { return DEFAULT_CONFIG; }
}
function writeConfig(data) {
  const tmp = CFG_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, CFG_FILE);
}

const DEFAULT_CONTENT = {
  contact:{ whatsapp:'', email:'', instagram:'https://www.instagram.com/barbivillaloboss', tiktok:'https://www.tiktok.com/@barbivillaloboss' },
  hero:{ badge:'Cosmetóloga Certificada · Santiago, Chile', title:'Tu piel merece\natención experta', subtitle:'Asesorías personalizadas en skincare para que entiendas tu piel y logres los resultados que buscas.', trustText:'+500 clientas ya transformaron su piel', stat1Value:'500+', stat1Label:'Pieles transformadas', stat2Value:'5 ★', stat2Label:'Valoración promedio' },
  cta:{ tag:'Sin rodeos. Sin ventas falsas.', title:'¿Lista para empezar\ncon tu piel?', subtitle:'Agenda tu consulta y recibe una asesoría personalizada basada en evidencia científica.' },
  footer:{ description:'Cosmetología con base científica. Asesorías para entender y transformar tu piel desde la raíz.', copyright:'© 2025 BOSSKIN — BarbiVillalobos. Todos los derechos reservados.' },
  testimonialMain:{ quote:'Llevaba años sin entender mi piel. Con Barbara aprendí a leer los ingredientes, armar una rutina real y dejar de gastar en productos que no servían. Mi piel cambió en cuatro semanas.', author:'Valentina M.', city:'Santiago, Chile' },
  reviews:[
    { quote:'Con Barbara entendí finalmente qué productos usar para mi piel mixta. La rutina que me armó es simple y los resultados se vieron en menos de un mes.', author:'Camila R.', location:'Viña del Mar' },
    { quote:'Revisamos todos mis productos y la mitad los estaba usando mal. Me ahorró plata y mejoró mi piel al mismo tiempo. Súper recomendada.', author:'Daniela F.', location:'Santiago' },
    { quote:'Tenía acné adulto que me daba mucha vergüenza. Barbara me explicó las causas reales y cómo tratarlo. Hoy mi piel está tranquila y sin inflamación.', author:'Andrea P.', location:'Concepción' },
    { quote:'La consulta express vale muchísimo para cuando tienes una duda puntual. Rápida, directa y con información de verdad.', author:'Javiera M.', location:'Santiago' },
    { quote:'La asesoría personalizada fue una inversión que se pagó sola. Dejé de comprar cosas al azar y ahora sé exactamente qué necesita mi piel.', author:'Fernanda L.', location:'Santiago' },
    { quote:'Llevo 3 meses aplicando la rutina que me dio Barbara y recibo comentarios sobre mi piel constantemente.', author:'Pilar C.', location:'Valparaíso' },
  ],
};

function readContent() {
  const src = fs.existsSync(CONTENT_FILE) ? CONTENT_FILE : path.join(__dirname, 'content.json');
  try { return { ...DEFAULT_CONTENT, ...JSON.parse(fs.readFileSync(src, 'utf8')) }; } catch { return DEFAULT_CONTENT; }
}
function writeContent(data) {
  const tmp = CONTENT_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, CONTENT_FILE);
}

/* ── JSON database ─────────────────────────────────────────────────────────── */
let _lock = false;
async function withLock(fn) {
  const start = Date.now();
  while (_lock) { if (Date.now() - start > 5000) throw new Error('Lock timeout'); await new Promise(r => setTimeout(r, 30)); }
  _lock = true;
  try { return await fn(); } finally { _lock = false; }
}
function readDB() { try { if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify({ bookings:[] })); return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { return { bookings:[] }; } }
function writeDB(data) { const tmp = DB_FILE+'.tmp'; fs.writeFileSync(tmp, JSON.stringify(data, null, 2)); fs.renameSync(tmp, DB_FILE); }
function getBookings() { return readDB().bookings; }
function updateBooking(id, changes) { const db = readDB(); db.bookings = db.bookings.map(b => b.id===id ? {...b,...changes} : b); writeDB(db); }
function deleteBooking(id) { const db = readDB(); db.bookings = db.bookings.filter(b => b.id!==id); writeDB(db); }
function readBlocked() {
  try {
    if (!fs.existsSync(BL_FILE)) return { dates:[], slots:{} };
    const d = JSON.parse(fs.readFileSync(BL_FILE, 'utf8'));
    return { dates: d.dates || [], slots: d.slots || {} };
  } catch { return { dates:[], slots:{} }; }
}
function writeBlocked(data) { fs.writeFileSync(BL_FILE, JSON.stringify(data, null, 2)); }

/* ── Upload de imágenes ───────────────────────────────────────────────────── */
const IMAGES_DIR = path.join(__dirname, 'images');
if (!fs.existsSync(IMAGES_DIR)) fs.mkdirSync(IMAGES_DIR, { recursive: true });

const ALLOWED_IMAGE_SLOTS = new Set(['barbara','consulta-express','asesoria-personalizada','revision-productos']);
const imageStorage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, IMAGES_DIR),
  filename: (req, file, cb) => {
    const slot = req.body.slot;
    const name = ALLOWED_IMAGE_SLOTS.has(slot)
      ? slot
      : path.basename(file.originalname, path.extname(file.originalname))
          .replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 50);
    cb(null, name + path.extname(file.originalname).toLowerCase());
  },
});
const upload = multer({
  storage: imageStorage,
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => cb(null, /^image\//i.test(file.mimetype)),
});

/* ── Validación ───────────────────────────────────────────────────────────── */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE  = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE  = /^\d{2}:\d{2}$/;

function validateBooking({ name, email, phone, date, time }) {
  if (!name  || name.trim().length  < 2)   return 'Nombre inválido';
  if (!email || !EMAIL_RE.test(email))      return 'Email inválido';
  if (!phone || phone.trim().length  < 6)   return 'Teléfono inválido';
  if (!date  || !DATE_RE.test(date))        return 'Fecha inválida';
  if (!time  || !TIME_RE.test(time))        return 'Hora inválida';
  const d = new Date(date + 'T12:00:00');
  if (isNaN(d) || d < new Date(new Date().toDateString())) return 'La fecha ya pasó';
  return null;
}

/* ── Forzar HTTPS ─────────────────────────────────────────────────────────── */
if (process.env.NODE_ENV === 'production') {
  app.use((req, res, next) => {
    if (req.headers['x-forwarded-proto'] !== 'https') return res.redirect(301, 'https://' + req.headers.host + req.url);
    next();
  });
}

/* ── Middlewares ──────────────────────────────────────────────────────────── */
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc:  ["'self'", "'unsafe-inline'"],
      styleSrc:   ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc:    ["'self'", 'https://fonts.gstatic.com'],
      imgSrc:     ["'self'", 'data:', 'https:', 'blob:'],
      connectSrc: ["'self'"],
      frameSrc:   ['https://www.mercadopago.cl', 'https://www.mercadopago.com', 'https://www.mercadolibre.com'],
    },
  },
}));
const ALLOWED = ['https://bosskinlab.com','https://www.bosskinlab.com','http://localhost:3004','http://localhost:3000'];
app.use(cors({ origin: (origin, cb) => cb(null, !origin || ALLOWED.includes(origin)), methods:['GET','POST','PATCH','PUT','DELETE','OPTIONS'], allowedHeaders:['Content-Type','Authorization'] }));
app.use(express.json({ limit:'2mb' }));
app.use(express.static(path.join(__dirname)));

/* ── Rate limiting ────────────────────────────────────────────────────────── */
const bookingLimiter  = rateLimit({ windowMs:60_000, max:5,   message:{ error:'Demasiadas solicitudes, intenta en 1 minuto.' } });
const adminLimiter    = rateLimit({ windowMs:60_000, max:60,  message:{ error:'Demasiadas solicitudes.' } });
const slotLimiter     = rateLimit({ windowMs:60_000, max:30,  message:{ error:'Demasiadas solicitudes.' } });
const calendarLimiter = rateLimit({ windowMs:60_000, max:20,  message:'Demasiadas solicitudes.' });



/* ── Duración de servicio: chequeo de solapamiento ───────────────────────── */
function toMinutes(timeStr) {
  const [h, m] = timeStr.split(':').map(Number);
  return h * 60 + m;
}

// Devuelve la reserva que ocupa el slot dado (considerando su duración), o null
function findOccupyingBooking(slotTime, dayBookings, services) {
  const slotStart = toMinutes(slotTime);
  for (const b of dayBookings) {
    const svc  = services.find(s => s.name === b.service);
    const dur  = svc?.duration || 60;
    const bStart = toMinutes(b.time);
    if (slotStart >= bStart && slotStart < bStart + dur) return b;
  }
  return null;
}

// Verifica si agendar un servicio de `requestedDur` minutos en `slotTime`
// chocaría con alguna reserva existente (chequeo hacia adelante)
function wouldConflictForward(slotTime, requestedDur, dayBookings) {
  if (!requestedDur) return false;
  const slotStart = toMinutes(slotTime);
  const slotEnd   = slotStart + requestedDur;
  return dayBookings.some(b => {
    const bStart = toMinutes(b.time);
    // El nuevo bloque [slotStart, slotEnd) se superpone con el inicio de b
    return bStart > slotStart && bStart < slotEnd;
  });
}

/* ── Admin auth ───────────────────────────────────────────────────────────── */
function adminAuth(req, res, next) {
  // Acepta cookie httpOnly (navegador) o Bearer header (herramientas CLI)
  const token = parseCookie(req, 'bosskin_admin') || (req.headers['authorization'] || '').replace('Bearer ', '');
  const expiry = sessions.get(token);
  if (!token || !expiry || expiry < Date.now()) {
    sessions.delete(token);
    return res.status(401).json({ error: 'Sesión expirada' });
  }
  sessions.set(token, Date.now() + 24 * 3_600_000);
  next();
}

const COOKIE_OPTS = {
  httpOnly: true,
  secure:   process.env.NODE_ENV === 'production',
  sameSite: 'lax',
  maxAge:   24 * 3_600_000,
  path:     '/',
};

app.post('/api/admin/login', adminLimiter, (req, res) => {
  const { password } = req.body;
  const stored = process.env.ADMIN_PASSWORD || '';
  // Comparación segura contra timing attacks
  const pwBuf = Buffer.from(String(password || '').padEnd(stored.length, '\0'));
  const stBuf = Buffer.from(stored.padEnd(String(password || '').length, '\0'));
  const same  = password && stored && password.length === stored.length && crypto.timingSafeEqual(pwBuf, stBuf);
  if (!same) return res.status(401).json({ error: 'Contraseña incorrecta' });

  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, Date.now() + 24 * 3_600_000);
  res.cookie('bosskin_admin', token, COOKIE_OPTS);
  res.json({ ok: true }); // no exponer el token al JS
});

app.post('/api/admin/logout', (req, res) => {
  const token = parseCookie(req, 'bosskin_admin') || (req.headers['authorization'] || '').replace('Bearer ', '');
  sessions.delete(token);
  res.clearCookie('bosskin_admin', { path: '/' });
  res.json({ ok: true });
});

/* ── Emails ───────────────────────────────────────────────────────────────── */
async function sendConfirmationEmail(booking) {
  if (!resend) return;
  const dateStr = new Date(booking.date + 'T12:00:00').toLocaleDateString('es-CL', { weekday:'long', day:'numeric', month:'long', year:'numeric' });
  try {
    await resend.emails.send({
      from:'BOSSKIN <reservas@bosskinlab.com>', to: booking.email,
      subject:`✓ Tu sesión está confirmada — ${dateStr}`,
      html:`<div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;background:#0e1a12;color:#fff;border-radius:12px">
        <h1 style="font-size:1.5rem;color:#D4EDE3;margin-bottom:8px">¡Tu sesión está confirmada!</h1>
        <p style="color:#9ca3af;margin-bottom:24px">Hola ${booking.name}, aquí está el detalle de tu reserva:</p>
        <table style="width:100%;border-collapse:collapse">
          <tr><td style="padding:10px 0;color:#6b7280;border-bottom:1px solid #1f2d24">Servicio</td><td style="padding:10px 0;border-bottom:1px solid #1f2d24;text-align:right">${booking.service}</td></tr>
          <tr><td style="padding:10px 0;color:#6b7280;border-bottom:1px solid #1f2d24">Fecha</td><td style="padding:10px 0;border-bottom:1px solid #1f2d24;text-align:right">${dateStr}</td></tr>
          <tr><td style="padding:10px 0;color:#6b7280">Hora</td><td style="padding:10px 0;text-align:right">${booking.time} hrs</td></tr>
        </table>
        <p style="margin-top:24px;color:#9ca3af;font-size:.85rem">Te enviaremos el link de videollamada antes de tu sesión.</p>
        ${booking.cancel_token ? `<p style="margin-top:12px;color:#9ca3af;font-size:.82rem">Para cancelar tu reserva (con al menos 24h de anticipación) <a href="${BASE_URL}/api/bookings/${booking.id}/cancel?token=${booking.cancel_token}" style="color:#D4EDE3">haz clic aquí</a>. Si necesitas reagendar escribe a <a href="mailto:reservas@bosskinlab.com" style="color:#D4EDE3">reservas@bosskinlab.com</a>.</p>` : `<p style="margin-top:12px;color:#9ca3af;font-size:.82rem">Si necesitas cancelar o reagendar escribe a <a href="mailto:reservas@bosskinlab.com" style="color:#D4EDE3">reservas@bosskinlab.com</a>.</p>`}
      </div>`
    });
    await resend.emails.send({
      from:'BOSSKIN <reservas@bosskinlab.com>', to: process.env.NOTIFICATION_EMAIL || 'reservas@bosskinlab.com',
      subject:`Nueva reserva confirmada — ${escHtml(booking.name)}`,
      html:`<p>Nueva reserva confirmada:</p><ul><li><b>Nombre:</b> ${escHtml(booking.name)}</li><li><b>Email:</b> ${escHtml(booking.email)}</li><li><b>Teléfono:</b> ${escHtml(booking.phone)}</li><li><b>Servicio:</b> ${escHtml(booking.service)}</li><li><b>Fecha:</b> ${escHtml(dateStr)}</li><li><b>Hora:</b> ${escHtml(booking.time)}</li></ul>`
    });
  } catch(e) { console.error('Email error:', e.message); }
}

/* ══════════════════════════════════════════════════════════════════════════
   RUTAS PÚBLICAS
══════════════════════════════════════════════════════════════════════════ */

/* ── Servicios activos (para el frontend) ────────────────────────────────── */
app.get('/api/services', (req, res) => {
  const cfg = readConfig();
  res.json(cfg.services.filter(s => s.active));
});

/* ── Contenido de la página (para el frontend) ───────────────────────────── */
app.get('/api/content', (req, res) => {
  res.json(readContent());
});

/* ── Horarios disponibles ─────────────────────────────────────────────────── */
app.get('/api/slots', slotLimiter, (req, res) => {
  const { date, service: serviceKey } = req.query;
  if (!date || !DATE_RE.test(date)) return res.status(400).json({ error:'Fecha inválida' });

  const cfg = readConfig();
  const { slots, workdays, minAdvanceHours = 2, maxAdvanceDays = 60 } = cfg.schedule;

  // Duración del servicio solicitado (para chequeo hacia adelante)
  const requestedSvc = cfg.services.find(s => s.key === serviceKey && s.active);
  const requestedDur = requestedSvc?.duration || 0;

  // Verificar día laborable
  const [y, m, d] = date.split('-').map(Number);
  const dow = new Date(y, m - 1, d).getDay();
  if (!workdays.includes(dow)) return res.json(slots.map(t => ({ time: t, available: false })));

  // Verificar rango de fechas
  const today     = new Date(); today.setHours(0,0,0,0);
  const dateObj   = new Date(y, m-1, d);
  const maxDate   = new Date(today); maxDate.setDate(maxDate.getDate() + maxAdvanceDays);
  if (dateObj < today || dateObj > maxDate) return res.json(slots.map(t => ({ time: t, available: false })));

  // Verificar si está bloqueada completa
  const bl = readBlocked();
  if (bl.dates.includes(date)) return res.json(slots.map(t => ({ time: t, available: false })));

  const blockedSlots = bl.slots[date] || [];
  const dayBookings  = getBookings().filter(b => b.date === date && b.status !== 'cancelado');
  const now          = new Date();

  res.json(slots.map(t => {
    const [h, min] = t.split(':').map(Number);
    const slotDt    = new Date(y, m-1, d, h, min);
    const hoursLeft = (slotDt - now) / 3_600_000;
    const occupied  = !!findOccupyingBooking(t, dayBookings, cfg.services);
    const forward   = wouldConflictForward(t, requestedDur, dayBookings);
    return { time: t, available: !occupied && !forward && !blockedSlots.includes(t) && hoursLeft >= minAdvanceHours };
  }));
});

/* ── Crear reserva ────────────────────────────────────────────────────────── */
app.post('/api/bookings', bookingLimiter, async (req, res) => {
  const { name, email, phone, date, time, service: serviceKey } = req.body;
  const err = validateBooking({ name, email, phone, date, time });
  if (err) return res.status(400).json({ error: err });

  const cfg = readConfig();
  const svc = cfg.services.find(s => s.key === serviceKey && s.active) || cfg.services.find(s => s.active);
  if (!svc) return res.status(400).json({ error:'Servicio no disponible' });

  if (!cfg.schedule.slots.includes(time)) return res.status(400).json({ error:'Hora no válida' });
  if (readBlocked().dates.includes(date)) return res.status(409).json({ error:'Fecha no disponible' });

  try {
    const result = await withLock(async () => {
      const clash = getBookings().find(b => b.date === date && b.time === time && b.status !== 'cancelado');
      if (clash) return { conflict: true };

      const id          = crypto.randomBytes(12).toString('hex');
      const cancelToken = crypto.randomBytes(16).toString('hex');
      const createdAt   = new Date().toISOString();
      const dateLabel = new Date(date + 'T12:00:00').toLocaleDateString('es-CL', { weekday:'long', day:'numeric', month:'long' });

      let paymentUrl = null, mpPrefId = null;
      try {
        const pref = new Preference(mpClient);
        const pd   = await pref.create({ body: {
          items: [{ title:`${svc.name} BOSSKIN — ${dateLabel} ${time} hrs`, unit_price: svc.price, quantity:1, currency_id:'CLP' }],
          payer: { name: name.trim(), email: email.trim() },
          external_reference: id,
          notification_url: `${BASE_URL}/api/webhook`,
          back_urls: {
            success: `${BASE_URL}/confirmacion.html?status=success&id=${id}`,
            failure: `${BASE_URL}/confirmacion.html?status=failure&id=${id}`,
            pending: `${BASE_URL}/confirmacion.html?status=pending&id=${id}`,
          },
          auto_return: 'approved',
        }});
        paymentUrl = pd.init_point;
        mpPrefId   = pd.id;
      } catch(mpErr) { console.error('MP error:', mpErr.message); }

      const db = readDB();
      db.bookings.push({ id, name:name.trim(), email:email.trim(), phone:phone.trim(), date, time, service:svc.name, price:svc.price, status:'pendiente', mp_preference_id:mpPrefId, cancel_token:cancelToken, created_at:createdAt });
      writeDB(db);
      return { id, paymentUrl };
    });

    if (result.conflict) return res.status(409).json({ error:'Ese horario ya fue reservado' });
    res.json(result);
  } catch(e) { console.error('Booking error:', e.message); res.status(500).json({ error:'Error interno, intenta nuevamente' }); }
});

/* ── Webhook Mercado Pago ─────────────────────────────────────────────────── */
app.post('/api/webhook', (req, res) => {
  res.sendStatus(200);

  // Verificar firma si se configuró MP_WEBHOOK_SECRET en el dashboard de MP
  const mpSecret = process.env.MP_WEBHOOK_SECRET;
  if (mpSecret) {
    const xSig   = req.headers['x-signature'] || '';
    const xReqId = req.headers['x-request-id'] || '';
    const ts     = xSig.match(/ts=([^,]+)/)?.[1];
    const v1     = xSig.match(/v1=([^,]+)/)?.[1];
    const dataId = req.body?.data?.id;
    if (!ts || !v1 || !dataId) { console.warn('⚠ Webhook sin firma válida'); return; }
    const manifest = `id:${dataId};request-id:${xReqId};ts:${ts};`;
    const expected = crypto.createHmac('sha256', mpSecret).update(manifest).digest('hex');
    try {
      const eBuf = Buffer.from(expected, 'hex');
      const vBuf = Buffer.from(v1, 'hex');
      if (eBuf.length !== vBuf.length || !crypto.timingSafeEqual(eBuf, vBuf)) {
        console.warn('⚠ Webhook firma inválida — ignorado'); return;
      }
    } catch { console.warn('⚠ Webhook firma malformada'); return; }
  }

  const { type, data } = req.body;
  if (type !== 'payment' || !data?.id) return;
  (async () => {
    try {
      const paymentApi = new Payment(mpClient);
      const payment    = await paymentApi.get({ id: data.id });
      if (payment.status !== 'approved') return;
      const booking = getBookings().find(b => b.id === payment.external_reference && b.status === 'pendiente');
      if (!booking) return;
      if (booking.price && payment.transaction_amount < booking.price) { console.warn(`⚠ Monto incorrecto ${data.id}`); return; }
      await withLock(async () => updateBooking(payment.external_reference, { status:'confirmado', mp_payment_id:String(data.id) }));
      console.log(`✓ Reserva confirmada: ${payment.external_reference}`);
      const updated = getBookings().find(b => b.id === payment.external_reference);
      if (updated) sendConfirmationEmail(updated);
    } catch(e) { console.error('Webhook error:', e.message); }
  })();
});

/* ── Reserva por ID ───────────────────────────────────────────────────────── */
app.get('/api/bookings/:id', slotLimiter, (req, res) => {
  const booking = getBookings().find(b => b.id === req.params.id);
  if (!booking) return res.status(404).json({ error:'Reserva no encontrada' });
  const { mp_preference_id, mp_payment_id, cancel_token, ...safe } = booking;
  res.json(safe);
});

/* ── Cancelar reserva ─────────────────────────────────────────────────────── */
app.delete('/api/bookings/:id/cancel', slotLimiter, (req, res) => {
  const { token } = req.query;
  const booking = getBookings().find(b => b.id === req.params.id);
  if (!booking) return res.status(404).json({ error:'Reserva no encontrada' });

  // Aceptar cancel_token del cliente O sesión admin activa
  const authToken = (req.headers['authorization'] || '').replace('Bearer ', '');
  const isAdmin   = authToken && (sessions.get(authToken) || 0) > Date.now();
  const validToken = booking.cancel_token && token === booking.cancel_token;
  if (!isAdmin && !validToken) return res.status(403).json({ error:'No autorizado' });

  const sessionDate = new Date(booking.date + 'T' + booking.time + ':00');
  const hoursLeft   = (sessionDate - new Date()) / 3_600_000;
  if (hoursLeft < 24) return res.status(400).json({ error:'No se puede cancelar con menos de 24 horas de anticipación.' });
  updateBooking(booking.id, { status:'cancelado' });
  res.json({ ok:true });
});

/* ══════════════════════════════════════════════════════════════════════════
   RUTAS ADMIN
══════════════════════════════════════════════════════════════════════════ */

/* ── Stats ───────────────────────────────────────────────────────────────── */
app.get('/api/admin/stats', adminLimiter, adminAuth, (req, res) => {
  const all   = getBookings();
  const today = new Date().toISOString().split('T')[0];
  const revenue = all.filter(b => b.status === 'confirmado').reduce((s, b) => s + (b.price || 0), 0);
  res.json({
    confirmed: all.filter(b => b.status === 'confirmado').length,
    pending:   all.filter(b => b.status === 'pendiente').length,
    cancelled: all.filter(b => b.status === 'cancelado').length,
    unique:    new Set(all.map(b => b.email.toLowerCase())).size,
    today:     all.filter(b => b.date === today && b.status === 'confirmado').length,
    revenue,
  });
});

/* ── Listar reservas ──────────────────────────────────────────────────────── */
const VALID_STATUSES = new Set(['confirmado','pendiente','cancelado']);
app.get('/api/admin/bookings', adminLimiter, adminAuth, (req, res) => {
  const { date, q, status } = req.query;
  let rows = getBookings();
  if (date && DATE_RE.test(date))               rows = rows.filter(b => b.date === date);
  if (status && VALID_STATUSES.has(status))     rows = rows.filter(b => b.status === status);
  if (q && typeof q === 'string' && q.length <= 100)
    rows = rows.filter(b => b.name.toLowerCase().includes(q.toLowerCase()) || b.email.toLowerCase().includes(q.toLowerCase()));
  rows.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  res.json(rows);
});

/* ── Confirmar pago manual ────────────────────────────────────────────────── */
app.patch('/api/admin/bookings/:id/confirm', adminLimiter, adminAuth, async (req, res) => {
  await withLock(async () => updateBooking(req.params.id, { status:'confirmado' }));
  const booking = getBookings().find(b => b.id === req.params.id);
  if (booking) sendConfirmationEmail(booking);
  res.json({ ok:true });
});

/* ── Eliminar reserva ─────────────────────────────────────────────────────── */
app.delete('/api/admin/bookings/:id', adminLimiter, adminAuth, (req, res) => {
  deleteBooking(req.params.id);
  res.json({ ok:true });
});

/* ── Reenviar email de confirmación ──────────────────────────────────────── */
app.post('/api/admin/bookings/:id/resend-email', adminLimiter, adminAuth, async (req, res) => {
  const booking = getBookings().find(b => b.id === req.params.id);
  if (!booking) return res.status(404).json({ error:'Reserva no encontrada' });
  if (booking.status !== 'confirmado') return res.status(400).json({ error:'Solo se puede reenviar en reservas confirmadas' });
  if (!resend) return res.status(503).json({ error:'Servicio de email no configurado' });
  try { await sendConfirmationEmail(booking); res.json({ ok:true }); }
  catch(e) { res.status(500).json({ error:'Error al enviar email: ' + e.message }); }
});

/* ── Fechas bloqueadas ────────────────────────────────────────────────────── */
app.get('/api/admin/blocked', adminLimiter, adminAuth, (req, res) => res.json(readBlocked().dates));
app.post('/api/admin/blocked', adminLimiter, adminAuth, (req, res) => {
  const { date } = req.body;
  if (!date || !DATE_RE.test(date)) return res.status(400).json({ error:'Fecha inválida' });
  const bl = readBlocked();
  if (!bl.dates.includes(date)) { bl.dates.push(date); writeBlocked(bl); }
  res.json({ ok:true });
});
app.delete('/api/admin/blocked/:date', adminLimiter, adminAuth, (req, res) => {
  const bl = readBlocked();
  bl.dates = bl.dates.filter(d => d !== req.params.date);
  writeBlocked(bl);
  res.json({ ok:true });
});

/* ── Config de servicios y horarios ──────────────────────────────────────── */
app.get('/api/admin/config', adminLimiter, adminAuth, (req, res) => res.json(readConfig()));
app.put('/api/admin/config', adminLimiter, adminAuth, (req, res) => {
  try {
    const cfg = req.body;
    if (!cfg.services || !cfg.schedule) return res.status(400).json({ error:'Estructura inválida' });
    writeConfig(cfg);
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

/* ── Contenido de la página ───────────────────────────────────────────────── */
app.get('/api/admin/content', adminLimiter, adminAuth, (req, res) => res.json(readContent()));
app.put('/api/admin/content', adminLimiter, adminAuth, (req, res) => {
  try {
    writeContent(req.body);
    res.json({ ok:true });
  } catch(e) { res.status(500).json({ error:e.message }); }
});

/* ── Upload de imágenes ───────────────────────────────────────────────────── */
app.post('/api/admin/upload', adminLimiter, adminAuth, upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error:'No se recibió imagen' });
  res.json({ ok:true, filename: req.file.filename, path: '/images/' + req.file.filename });
});

/* ── Vista de agenda por día ──────────────────────────────────────────────── */
app.get('/api/admin/schedule/:date', adminLimiter, adminAuth, (req, res) => {
  const { date } = req.params;
  if (!DATE_RE.test(date)) return res.status(400).json({ error:'Fecha inválida' });
  const cfg          = readConfig();
  const bl           = readBlocked();
  const dayBookings  = getBookings().filter(b => b.date === date && b.status !== 'cancelado');
  const blockedSlots = bl.slots[date] || [];
  const fullBlocked  = bl.dates.includes(date);

  const result = cfg.schedule.slots.map(time => {
    if (fullBlocked) return { time, status:'blocked', fullDay:true };
    const bk = findOccupyingBooking(time, dayBookings, cfg.services);
    if (bk)                          return { time, status:'booked',  booking:{ id:bk.id, name:bk.name, service:bk.service, email:bk.email, phone:bk.phone, bookedAt: bk.time } };
    if (blockedSlots.includes(time)) return { time, status:'blocked' };
    return { time, status:'available' };
  });
  res.json({ slots: result, fullBlocked });
});

/* Vista resumida del mes para el calendario */
app.get('/api/admin/month-bookings/:year/:month', adminLimiter, adminAuth, (req, res) => {
  const { year, month } = req.params;
  const prefix = `${year}-${String(month).padStart(2,'0')}`;
  const all    = getBookings().filter(b => b.date.startsWith(prefix) && b.status !== 'cancelado');
  const byDay  = {};
  all.forEach(b => { byDay[b.date] = (byDay[b.date] || 0) + 1; });
  res.json(byDay);
});

/* ── Bloqueo por slot individual ──────────────────────────────────────────── */
app.post('/api/admin/blocked-slots', adminLimiter, adminAuth, (req, res) => {
  const { date, time } = req.body;
  if (!DATE_RE.test(date) || !TIME_RE.test(time)) return res.status(400).json({ error:'Datos inválidos' });
  const bl = readBlocked();
  if (!bl.slots[date]) bl.slots[date] = [];
  if (!bl.slots[date].includes(time)) bl.slots[date].push(time);
  writeBlocked(bl);
  res.json({ ok:true });
});

app.delete('/api/admin/blocked-slots/:date/:time', adminLimiter, adminAuth, (req, res) => {
  const { date, time } = req.params;
  const bl = readBlocked();
  if (bl.slots[date]) {
    bl.slots[date] = bl.slots[date].filter(t => t !== time);
    if (!bl.slots[date].length) delete bl.slots[date];
  }
  writeBlocked(bl);
  res.json({ ok:true });
});

/* ── Export config/content como JSON (para sincronizar con repo) ──────────── */
app.get('/api/admin/export', adminLimiter, adminAuth, (req, res) => {
  res.json({ config: readConfig(), content: readContent() });
});

/* ── Calendario ICS ───────────────────────────────────────────────────────── */
function calToken() {
  // Usa CALENDAR_SECRET si está definida; si no, deriva de ADMIN_PASSWORD con sal diferente
  const secret = process.env.CALENDAR_SECRET || (process.env.ADMIN_PASSWORD || '') + '_cal_bosskin_2025';
  return crypto.createHmac('sha256', secret).update('bosskin-calendar-v2').digest('hex').slice(0, 32);
}
function toICSDate(date, time, offsetMins=0) {
  const [y,m,d] = date.split('-').map(Number);
  const [h,min] = time.split(':').map(Number);
  const dt = new Date(Date.UTC(y,m-1,d,h,min+offsetMins));
  return dt.toISOString().replace(/[-:]/g,'').split('.')[0]+'Z';
}
function escapeICS(str) { return String(str).replace(/\\/g,'\\\\').replace(/;/g,'\\;').replace(/,/g,'\\,').replace(/\n/g,'\\n'); }

app.get('/api/calendar.ics', calendarLimiter, (req, res) => {
  if (req.query.token !== calToken()) return res.status(401).send('No autorizado');
  const cfg      = readConfig();
  const durMap   = Object.fromEntries(cfg.services.map(s => [s.name, s.duration]));
  const bookings = getBookings().filter(b => b.status === 'confirmado');
  const events   = bookings.map(b => {
    const dur   = durMap[b.service] || 60;
    return ['BEGIN:VEVENT',`UID:${b.id}@bosskinlab.com`,`DTSTART:${toICSDate(b.date,b.time)}`,`DTEND:${toICSDate(b.date,b.time,dur)}`,`SUMMARY:${escapeICS(b.service)} — ${escapeICS(b.name)}`,`DESCRIPTION:${escapeICS(b.name)}\\nEmail: ${escapeICS(b.email)}\\nTeléfono: ${escapeICS(b.phone)}`,`LOCATION:Videollamada`,`STATUS:CONFIRMED`,`DTSTAMP:${new Date().toISOString().replace(/[-:]/g,'').split('.')[0]}Z`,'END:VEVENT'].join('\r\n');
  }).join('\r\n');
  const ics = ['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//BOSSKIN//Reservas//ES','CALSCALE:GREGORIAN','METHOD:PUBLISH','X-WR-CALNAME:BOSSKIN Reservas','X-WR-TIMEZONE:America/Santiago','REFRESH-INTERVAL;VALUE=DURATION:PT1H',events,'END:VCALENDAR'].join('\r\n');
  res.setHeader('Content-Type','text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition','inline; filename="bosskin-reservas.ics"');
  res.send(ics);
});
app.get('/api/admin/calendar-url', adminLimiter, adminAuth, (req, res) => res.json({ url:`${BASE_URL}/api/calendar.ics?token=${calToken()}` }));

/* ── 404 ──────────────────────────────────────────────────────────────────── */
app.use('/api', (req, res) => res.status(404).json({ error:'Endpoint no encontrado' }));

app.listen(PORT, () => {
  console.log(`\n  BOSSKIN corriendo en http://localhost:${PORT}`);
  console.log(`  Admin panel:  http://localhost:${PORT}/admin.html\n`);
});
