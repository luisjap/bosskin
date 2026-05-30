require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const path     = require('path');
const fs       = require('fs');
const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');

const app      = express();
const PORT     = process.env.PORT || 3004;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const DB_FILE  = path.join(__dirname, 'bookings.json');

/* ── Mercado Pago ─────────────────────────────────────────────────────────── */
const mpClient = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN });

/* ── JSON "database" ─────────────────────────────────────────────────────── */
function readDB() {
  if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify({ bookings: [] }));
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}
function writeDB(data) {
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}
function getBookings()        { return readDB().bookings; }
function saveBooking(booking) { const db = readDB(); db.bookings.push(booking); writeDB(db); }
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

/* ── Middlewares ──────────────────────────────────────────────────────────── */
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

/* ── Admin auth ───────────────────────────────────────────────────────────── */
function adminAuth(req, res, next) {
  if (req.headers['authorization'] === `Bearer ${process.env.ADMIN_PASSWORD}`) return next();
  res.status(401).json({ error: 'No autorizado' });
}

/* ── Servicios y precios ──────────────────────────────────────────────────── */
const ALL_SLOTS = ['11:00','12:00','13:00','14:00','15:00','16:00','17:00','18:00','19:00'];
const SERVICES = {
  express:  { name: 'Consulta Express',        price: 6500  },
  asesoria: { name: 'Asesoría Personalizada',  price: 20000 },
  revision: { name: 'Revisión de Productos',   price: 10000 }
};

app.get('/api/slots', (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: 'date requerido' });
  const taken = getBookings().filter(b => b.date === date).map(b => b.time);
  res.json(ALL_SLOTS.map(t => ({ time: t, available: !taken.includes(t) })));
});

/* ── Crear reserva + preferencia MP ──────────────────────────────────────── */
app.post('/api/bookings', async (req, res) => {
  const { name, email, phone, date, time, service: serviceKey } = req.body;
  if (!name || !email || !phone || !date || !time)
    return res.status(400).json({ error: 'Faltan campos requeridos' });

  const svc = SERVICES[serviceKey] || SERVICES.asesoria;

  const clash = getBookings().find(b => b.date === date && b.time === time);
  if (clash) return res.status(409).json({ error: 'Ese horario ya está reservado' });

  const id        = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const createdAt = new Date().toISOString();
  const dateLabel = new Date(date + 'T12:00:00').toLocaleDateString('es-CL', {
    weekday: 'long', day: 'numeric', month: 'long'
  });

  try {
    const pref     = new Preference(mpClient);
    const prefData = await pref.create({
      body: {
        items: [{
          title:       `${svc.name} BOSSKIN — ${dateLabel} ${time} hrs`,
          unit_price:  svc.price,
          quantity:    1,
          currency_id: 'CLP'
        }],
        payer: { name, email },
        external_reference: id,
        notification_url: `${BASE_URL}/api/webhook`,
        back_urls: {
          success: `${BASE_URL}/confirmacion.html?status=success&id=${id}`,
          failure: `${BASE_URL}/confirmacion.html?status=failure&id=${id}`,
          pending: `${BASE_URL}/confirmacion.html?status=pending&id=${id}`
        },
        auto_return: 'approved'
      }
    });

    saveBooking({ id, name, email, phone, date, time, service: svc.name, status: 'pendiente', mp_preference_id: prefData.id, created_at: createdAt });
    res.json({ id, paymentUrl: prefData.init_point });

  } catch (err) {
    console.error('MP error:', err.message);
    saveBooking({ id, name, email, phone, date, time, service: svc.name, status: 'pendiente', mp_preference_id: null, created_at: createdAt });
    res.status(500).json({ error: 'Error al crear preferencia de pago', id });
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
      if (payment.status === 'approved') {
        updateBooking(payment.external_reference, { status: 'confirmado', mp_payment_id: String(data.id) });
        console.log(`✓ Reserva confirmada automáticamente: ${payment.external_reference}`);
      }
    } catch (err) { console.error('Webhook error:', err.message); }
  })();
});

/* ── Obtener reserva por ID ───────────────────────────────────────────────── */
app.get('/api/bookings/:id', (req, res) => {
  const booking = getBookings().find(b => b.id === req.params.id);
  if (!booking) return res.status(404).json({ error: 'Reserva no encontrada' });
  res.json(booking);
});

/* ── Admin: estadísticas ──────────────────────────────────────────────────── */
app.get('/api/admin/stats', adminAuth, (req, res) => {
  const all   = getBookings();
  const today = new Date().toISOString().split('T')[0];
  res.json({
    confirmed: all.filter(b => b.status === 'confirmado').length,
    pending:   all.filter(b => b.status === 'pendiente').length,
    unique:    new Set(all.map(b => b.email.toLowerCase())).size,
    today:     all.filter(b => b.date === today).length
  });
});

/* ── Admin: listar reservas ──────────────────────────────────────────────── */
app.get('/api/admin/bookings', adminAuth, (req, res) => {
  const { date, q } = req.query;
  let rows = getBookings();
  if (date) rows = rows.filter(b => b.date === date);
  if (q)    rows = rows.filter(b => b.name.toLowerCase().includes(q.toLowerCase()) || b.email.toLowerCase().includes(q.toLowerCase()));
  rows.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  res.json(rows);
});

/* ── Admin: confirmar pago manual ─────────────────────────────────────────── */
app.patch('/api/admin/bookings/:id/confirm', adminAuth, (req, res) => {
  updateBooking(req.params.id, { status: 'confirmado' });
  res.json({ ok: true });
});

/* ── Admin: eliminar reserva ──────────────────────────────────────────────── */
app.delete('/api/admin/bookings/:id', adminAuth, (req, res) => {
  deleteBooking(req.params.id);
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log(`\n  BOSSKIN corriendo en http://localhost:${PORT}`);
  console.log(`  Admin panel:  http://localhost:${PORT}/admin.html\n`);
});
