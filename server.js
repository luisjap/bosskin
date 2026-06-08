require('dotenv').config();
const express      = require('express');
const cors         = require('cors');
const helmet       = require('helmet');
const rateLimit    = require('express-rate-limit');
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
const DB_FILE  = path.join(DATA_DIR, 'bookings.json');
const BL_FILE  = path.join(DATA_DIR, 'blocked.json');

const resend   = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;
const mpClient = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN || '' });

/* ── JSON database con lock para evitar race conditions ───────────────────── */
let _lock = false;
async function withLock(fn) {
  const start = Date.now();
  while (_lock) {
    if (Date.now() - start > 5000) throw new Error('Lock timeout');
    await new Promise(r => setTimeout(r, 30));
  }
  _lock = true;
  try { return await fn(); } finally { _lock = false; }
}

function readDB() {
  try {
    if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify({ bookings: [] }));
    return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch { return { bookings: [] }; }
}
function writeDB(data) {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, DB_FILE); // Atomic write
}
function getBookings()        { return readDB().bookings; }
function updateBooking(id, changes) {
  const db = readDB();
  db.bookings = db.bookings.map(b => b.id === id ? { ...b, ...changes } : b);
  writeDB(db);
}
function deleteBooking(id) {
  const db = readDB();
  db.bookings = db.bookings.filter(b => b.id !== id);
  writeDB(db);
}

function readBlocked() {
  try {
    if (!fs.existsSync(BL_FILE)) fs.writeFileSync(BL_FILE, JSON.stringify({ dates: [] }));
    return JSON.parse(fs.readFileSync(BL_FILE, 'utf8'));
  } catch { return { dates: [] }; }
}
function writeBlocked(data) { fs.writeFileSync(BL_FILE, JSON.stringify(data, null, 2)); }

/* ── Validación de inputs ─────────────────────────────────────────────────── */
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

/* ── Forzar HTTPS en producción ──────────────────────────────────────────── */
if (process.env.NODE_ENV === 'production') {
  app.use((req, res, next) => {
    if (req.headers['x-forwarded-proto'] !== 'https') {
      return res.redirect(301, 'https://' + req.headers.host + req.url);
    }
    next();
  });
}

/* ── Seguridad: headers ───────────────────────────────────────────────────── */
app.use(helmet({ contentSecurityPolicy: false }));

/* ── CORS restringido ─────────────────────────────────────────────────────── */
const ALLOWED = ['https://bosskinlab.com', 'https://www.bosskinlab.com', 'http://localhost:3004', 'http://localhost:3000'];
app.use(cors({
  origin: (origin, cb) => cb(null, !origin || ALLOWED.includes(origin)),
  methods: ['GET','POST','PATCH','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization']
}));

app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname)));

/* ── Rate limiting ────────────────────────────────────────────────────────── */
const bookingLimiter = rateLimit({ windowMs: 60_000, max: 5,  message: { error: 'Demasiadas solicitudes, intenta en 1 minuto.' } });
const adminLimiter   = rateLimit({ windowMs: 60_000, max: 30, message: { error: 'Demasiadas solicitudes.' } });
const slotLimiter    = rateLimit({ windowMs: 60_000, max: 30, message: { error: 'Demasiadas solicitudes.' } });

/* ── Admin auth ───────────────────────────────────────────────────────────── */
function adminAuth(req, res, next) {
  if (req.headers['authorization'] === `Bearer ${process.env.ADMIN_PASSWORD}`) return next();
  res.status(401).json({ error: 'No autorizado' });
}

/* ── Servicios y precios ──────────────────────────────────────────────────── */
const ALL_SLOTS = ['11:00','12:00','13:00','14:00','15:00','16:00','17:00','18:00','19:00'];
const SERVICES = {
  express:  { name: 'Consulta Express',       price: 6500  },
  asesoria: { name: 'Asesoría Personalizada', price: 20000 },
  revision: { name: 'Revisión de Productos',  price: 10000 }
};

/* ── Emails con Resend ────────────────────────────────────────────────────── */
async function sendConfirmationEmail(booking) {
  if (!resend) return;
  const dateStr = new Date(booking.date + 'T12:00:00').toLocaleDateString('es-CL', { weekday:'long', day:'numeric', month:'long', year:'numeric' });
  try {
    await resend.emails.send({
      from: 'BOSSKIN <reservas@bosskinlab.com>',
      to:   booking.email,
      subject: `✓ Tu sesión está confirmada — ${dateStr}`,
      html: `
        <div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;background:#0e1a12;color:#fff;border-radius:12px">
          <h1 style="font-size:1.5rem;color:#D4EDE3;margin-bottom:8px">¡Tu sesión está confirmada!</h1>
          <p style="color:#9ca3af;margin-bottom:24px">Hola ${booking.name}, aquí está el detalle de tu reserva:</p>
          <table style="width:100%;border-collapse:collapse">
            <tr><td style="padding:10px 0;color:#6b7280;border-bottom:1px solid #1f2d24">Servicio</td><td style="padding:10px 0;border-bottom:1px solid #1f2d24;text-align:right">${booking.service}</td></tr>
            <tr><td style="padding:10px 0;color:#6b7280;border-bottom:1px solid #1f2d24">Fecha</td><td style="padding:10px 0;border-bottom:1px solid #1f2d24;text-align:right">${dateStr}</td></tr>
            <tr><td style="padding:10px 0;color:#6b7280">Hora</td><td style="padding:10px 0;text-align:right">${booking.time} hrs</td></tr>
          </table>
          <p style="margin-top:24px;color:#9ca3af;font-size:.85rem">Te enviaremos el link de videollamada antes de tu sesión. Si necesitas cancelar o reagendar escribe a <a href="mailto:reservas@bosskinlab.com" style="color:#D4EDE3">reservas@bosskinlab.com</a>.</p>
        </div>`
    });
    await resend.emails.send({
      from: 'BOSSKIN <reservas@bosskinlab.com>',
      to:   process.env.NOTIFICATION_EMAIL || 'reservas@bosskinlab.com',
      subject: `Nueva reserva confirmada — ${booking.name}`,
      html: `<p>Nueva reserva confirmada:</p><ul><li><b>Nombre:</b> ${booking.name}</li><li><b>Email:</b> ${booking.email}</li><li><b>Teléfono:</b> ${booking.phone}</li><li><b>Servicio:</b> ${booking.service}</li><li><b>Fecha:</b> ${dateStr}</li><li><b>Hora:</b> ${booking.time}</li></ul>`
    });
  } catch (e) { console.error('Email error:', e.message); }
}

/* ── Horarios disponibles ─────────────────────────────────────────────────── */
app.get('/api/slots', slotLimiter, (req, res) => {
  const { date } = req.query;
  if (!date || !DATE_RE.test(date)) return res.status(400).json({ error: 'Fecha inválida' });
  const blocked = readBlocked().dates;
  if (blocked.includes(date)) return res.json(ALL_SLOTS.map(t => ({ time: t, available: false })));
  const taken = getBookings().filter(b => b.date === date).map(b => b.time);
  res.json(ALL_SLOTS.map(t => ({ time: t, available: !taken.includes(t) })));
});

/* ── Crear reserva ────────────────────────────────────────────────────────── */
app.post('/api/bookings', bookingLimiter, async (req, res) => {
  const { name, email, phone, date, time, service: serviceKey } = req.body;
  const err = validateBooking({ name, email, phone, date, time });
  if (err) return res.status(400).json({ error: err });

  if (!ALL_SLOTS.includes(time)) return res.status(400).json({ error: 'Hora no válida' });
  if (readBlocked().dates.includes(date)) return res.status(409).json({ error: 'Fecha no disponible' });

  const svc = SERVICES[serviceKey] || SERVICES.asesoria;

  try {
    const result = await withLock(async () => {
      const clash = getBookings().find(b => b.date === date && b.time === time);
      if (clash) return { conflict: true };

      const id        = crypto.randomBytes(12).toString('hex');
      const createdAt = new Date().toISOString();
      const dateLabel = new Date(date + 'T12:00:00').toLocaleDateString('es-CL', { weekday:'long', day:'numeric', month:'long' });

      let paymentUrl = null, mpPrefId = null;
      try {
        const pref = new Preference(mpClient);
        const pd   = await pref.create({ body: {
          items: [{ title: `${svc.name} BOSSKIN — ${dateLabel} ${time} hrs`, unit_price: svc.price, quantity: 1, currency_id: 'CLP' }],
          payer: { name: name.trim(), email: email.trim() },
          external_reference: id,
          notification_url: `${BASE_URL}/api/webhook`,
          back_urls: {
            success: `${BASE_URL}/confirmacion.html?status=success&id=${id}`,
            failure: `${BASE_URL}/confirmacion.html?status=failure&id=${id}`,
            pending: `${BASE_URL}/confirmacion.html?status=pending&id=${id}`
          },
          auto_return: 'approved'
        }});
        paymentUrl = pd.init_point;
        mpPrefId   = pd.id;
      } catch (mpErr) { console.error('MP error:', mpErr.message); }

      const db = readDB();
      db.bookings.push({ id, name: name.trim(), email: email.trim(), phone: phone.trim(), date, time, service: svc.name, status: 'pendiente', mp_preference_id: mpPrefId, created_at: createdAt });
      writeDB(db);
      return { id, paymentUrl };
    });

    if (result.conflict) return res.status(409).json({ error: 'Ese horario ya fue reservado' });
    res.json(result);
  } catch (e) {
    console.error('Booking error:', e.message);
    res.status(500).json({ error: 'Error interno, intenta nuevamente' });
  }
});

/* ── Webhook Mercado Pago ─────────────────────────────────────────────────── */
app.post('/api/webhook', (req, res) => {
  res.sendStatus(200);
  const { type, data } = req.body;
  if (type !== 'payment' || !data?.id) return;
  (async () => {
    try {
      const paymentApi = new Payment(mpClient);
      const payment    = await paymentApi.get({ id: data.id });
      if (payment.status !== 'approved') return;
      const bookings = getBookings();
      const booking  = bookings.find(b => b.id === payment.external_reference && b.status === 'pendiente');
      if (!booking) return;
      // Verificar que el monto coincide con el servicio
      const svc = Object.values(SERVICES).find(s => s.name === booking.service);
      if (svc && payment.transaction_amount < svc.price) {
        console.warn(`⚠ Monto incorrecto en pago ${data.id}`);
        return;
      }
      await withLock(async () => updateBooking(payment.external_reference, { status: 'confirmado', mp_payment_id: String(data.id) }));
      console.log(`✓ Reserva confirmada: ${payment.external_reference}`);
      const updated = getBookings().find(b => b.id === payment.external_reference);
      if (updated) sendConfirmationEmail(updated);
    } catch (e) { console.error('Webhook error:', e.message); }
  })();
});

/* ── Reserva por ID ──────────────────────────────────────────────────────── */
app.get('/api/bookings/:id', (req, res) => {
  const booking = getBookings().find(b => b.id === req.params.id);
  if (!booking) return res.status(404).json({ error: 'Reserva no encontrada' });
  const { mp_preference_id, mp_payment_id, ...safe } = booking;
  res.json(safe);
});

/* ── Cancelar reserva (política 24h) ─────────────────────────────────────── */
app.delete('/api/bookings/:id/cancel', (req, res) => {
  const booking = getBookings().find(b => b.id === req.params.id);
  if (!booking) return res.status(404).json({ error: 'Reserva no encontrada' });
  const sessionDate = new Date(booking.date + 'T' + booking.time + ':00');
  const hoursLeft   = (sessionDate - new Date()) / 3_600_000;
  if (hoursLeft < 24) return res.status(400).json({ error: 'No se puede cancelar con menos de 24 horas de anticipación. Contáctanos directamente.' });
  updateBooking(booking.id, { status: 'cancelado' });
  res.json({ ok: true });
});

/* ── Admin: estadísticas ──────────────────────────────────────────────────── */
app.get('/api/admin/stats', adminLimiter, adminAuth, (req, res) => {
  const all   = getBookings();
  const today = new Date().toISOString().split('T')[0];
  const revenue = all.filter(b => b.status === 'confirmado').reduce((s, b) => {
    const svc = Object.values(SERVICES).find(sv => sv.name === b.service);
    return s + (svc?.price || 0);
  }, 0);
  res.json({
    confirmed: all.filter(b => b.status === 'confirmado').length,
    pending:   all.filter(b => b.status === 'pendiente').length,
    cancelled: all.filter(b => b.status === 'cancelado').length,
    unique:    new Set(all.map(b => b.email.toLowerCase())).size,
    today:     all.filter(b => b.date === today).length,
    revenue
  });
});

/* ── Admin: listar reservas ──────────────────────────────────────────────── */
app.get('/api/admin/bookings', adminLimiter, adminAuth, (req, res) => {
  const { date, q, status } = req.query;
  let rows = getBookings();
  if (date)   rows = rows.filter(b => b.date === date);
  if (status) rows = rows.filter(b => b.status === status);
  if (q)      rows = rows.filter(b => b.name.toLowerCase().includes(q.toLowerCase()) || b.email.toLowerCase().includes(q.toLowerCase()));
  rows.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  res.json(rows);
});

/* ── Admin: confirmar pago manual ─────────────────────────────────────────── */
app.patch('/api/admin/bookings/:id/confirm', adminLimiter, adminAuth, async (req, res) => {
  await withLock(async () => updateBooking(req.params.id, { status: 'confirmado' }));
  const booking = getBookings().find(b => b.id === req.params.id);
  if (booking) sendConfirmationEmail(booking);
  res.json({ ok: true });
});

/* ── Admin: eliminar reserva ──────────────────────────────────────────────── */
app.delete('/api/admin/bookings/:id', adminLimiter, adminAuth, (req, res) => {
  deleteBooking(req.params.id);
  res.json({ ok: true });
});

/* ── Admin: fechas bloqueadas ─────────────────────────────────────────────── */
app.get('/api/admin/blocked', adminLimiter, adminAuth, (req, res) => {
  res.json(readBlocked().dates);
});
app.post('/api/admin/blocked', adminLimiter, adminAuth, (req, res) => {
  const { date } = req.body;
  if (!date || !DATE_RE.test(date)) return res.status(400).json({ error: 'Fecha inválida' });
  const bl = readBlocked();
  if (!bl.dates.includes(date)) { bl.dates.push(date); writeBlocked(bl); }
  res.json({ ok: true });
});
app.delete('/api/admin/blocked/:date', adminLimiter, adminAuth, (req, res) => {
  const bl = readBlocked();
  bl.dates  = bl.dates.filter(d => d !== req.params.date);
  writeBlocked(bl);
  res.json({ ok: true });
});

/* ── Calendario ICS ───────────────────────────────────────────────────────── */
const SERVICE_DURATION = {
  'Consulta Express':       25,
  'Asesoría Personalizada': 60,
  'Revisión de Productos':  20
};

function calToken() {
  return crypto.createHash('sha256').update((process.env.ADMIN_PASSWORD || '') + 'ics').digest('hex').slice(0, 20);
}

function toICSDate(date, time, offsetMins = 0) {
  const [y, m, d] = date.split('-').map(Number);
  const [h, min]  = time.split(':').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, h, min + offsetMins));
  return dt.toISOString().replace(/[-:]/g,'').split('.')[0] + 'Z';
}

function escapeICS(str) {
  return String(str).replace(/\\/g,'\\\\').replace(/;/g,'\\;').replace(/,/g,'\\,').replace(/\n/g,'\\n');
}

app.get('/api/calendar.ics', (req, res) => {
  if (req.query.token !== calToken()) return res.status(401).send('No autorizado');

  const bookings = getBookings().filter(b => b.status === 'confirmado');
  const events   = bookings.map(b => {
    const dur   = SERVICE_DURATION[b.service] || 60;
    const start = toICSDate(b.date, b.time);
    const end   = toICSDate(b.date, b.time, dur);
    return [
      'BEGIN:VEVENT',
      `UID:${b.id}@bosskinlab.com`,
      `DTSTART:${start}`,
      `DTEND:${end}`,
      `SUMMARY:${escapeICS(b.service)} — ${escapeICS(b.name)}`,
      `DESCRIPTION:${escapeICS(b.name)}\\nEmail: ${escapeICS(b.email)}\\nTeléfono: ${escapeICS(b.phone)}`,
      `LOCATION:Videollamada`,
      `STATUS:CONFIRMED`,
      `DTSTAMP:${new Date().toISOString().replace(/[-:]/g,'').split('.')[0]}Z`,
      'END:VEVENT'
    ].join('\r\n');
  }).join('\r\n');

  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//BOSSKIN//Reservas//ES',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'X-WR-CALNAME:BOSSKIN Reservas',
    'X-WR-TIMEZONE:America/Santiago',
    'X-WR-CALDESC:Asesorías confirmadas — Barbara Villalobos',
    'REFRESH-INTERVAL;VALUE=DURATION:PT1H',
    events,
    'END:VCALENDAR'
  ].join('\r\n');

  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', 'inline; filename="bosskin-reservas.ics"');
  res.send(ics);
});

app.get('/api/admin/calendar-url', adminLimiter, adminAuth, (req, res) => {
  res.json({ url: `${BASE_URL}/api/calendar.ics?token=${calToken()}` });
});

/* ── 404 ──────────────────────────────────────────────────────────────────── */
app.use('/api', (req, res) => res.status(404).json({ error: 'Endpoint no encontrado' }));

app.listen(PORT, () => {
  console.log(`\n  BOSSKIN corriendo en http://localhost:${PORT}`);
  console.log(`  Admin panel:  http://localhost:${PORT}/admin.html\n`);
});
