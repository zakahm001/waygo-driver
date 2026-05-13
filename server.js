require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const http = require('http');
const { Server } = require('socket.io');
let stripe = null;
try {
  if (process.env.STRIPE_SECRET_KEY) {
    stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
    console.log('Stripe initialized');
  } else {
    console.log('Stripe not configured - payment routes disabled');
  }
} catch(e) {
  console.log('Stripe init error:', e.message);
}
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');

// ── EMAIL SETUP ──
var emailTransporter = null;
if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
  emailTransporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_PORT === '465',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
  console.log('Email transporter configured:', process.env.SMTP_USER);
}

async function sendEmail(to, subject, htmlBody) {
  if (!emailTransporter) {
    console.log('No email config - skipping email to:', to);
    return;
  }
  try {
    await emailTransporter.sendMail({
      from: '"Trollhättan Cab" <' + process.env.SMTP_USER + '>',
      to: to,
      subject: subject,
      html: htmlBody
    });
    console.log('Email sent to:', to);
  } catch (e) {
    console.log('Email failed:', e.message);
  }
}

const app = express();
const server = http.createServer(app);
// Track pending dispatches so driver gets them on reconnect
const pendingDispatches = new Map(); // driverId -> {booking, expires}

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET','POST','PATCH','DELETE'] }
});

const PORT = 3000;
const JWT_SECRET = 'waygo-secret-2025';
const STAFF_SECRET = 'waygo-staff-2025';
const ELKS_USER = 'u7a7b323b5af0436c7dbfd1140e7c0221';
const ELKS_PWD = 'C44F26D562BB300E2CAB4AE20BF5DDFD';
const ELKS_FROM = 'THTCab';

app.use(cors({ origin: '*' }));
app.use(express.json());

const pool = new Pool({
  user: 'waygo_user', host: 'localhost',
  database: 'waygo', password: 'Waygo2025!', port: 5432,
});

const driverPositions = {};

function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });
  try { req.customer = jwt.verify(token, JWT_SECRET); next(); }
  catch (err) { res.status(401).json({ error: 'Invalid token' }); }
}

function staffMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });
  try { req.staff = jwt.verify(token, STAFF_SECRET); next(); }
  catch (err) { res.status(401).json({ error: 'Invalid staff token' }); }
}

function adminMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });
  try {
    req.staff = jwt.verify(token, STAFF_SECRET);
    if (req.staff.level > 2) return res.status(403).json({ error: 'Admin only' });
    next();
  } catch (err) { res.status(401).json({ error: 'Invalid staff token' }); }
}

async function sendSMS(to, message) {
  try {
    const phone = to.replace(/\D/g, '');
    const intl = phone.startsWith('0') ? '+46' + phone.slice(1) : '+' + phone;
    const body = new URLSearchParams({ from: ELKS_FROM, to: intl, message });
    const res = await fetch('https://api.46elks.com/a1/sms', {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + Buffer.from(ELKS_USER + ':' + ELKS_PWD).toString('base64'),
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: body.toString()
    });
    const data = await res.json();
    console.log('SMS sent:', data.status, 'to', intl);
  } catch(e) { console.log('SMS error:', e.message); }
}

app.get('/', (req, res) => {
  res.json({ message: 'Trollhättan Cab API running', status: 'ok',
    version: '5.4', database: 'connected', realtime: 'socket.io active' });
});

app.post('/staff/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'E-post och lösenord krävs' });
    const r = await pool.query('SELECT * FROM staff WHERE email=$1', [email]);
    if (!r.rows.length) return res.status(401).json({ error: 'Fel e-post eller lösenord' });
    const staff = r.rows[0];
    const valid = await bcrypt.compare(password, staff.password_hash);
    if (!valid) return res.status(401).json({ error: 'Fel e-post eller lösenord' });
    const token = jwt.sign(
      { id: staff.id, email: staff.email, name: staff.name, role: staff.role, level: staff.level || 3 },
      STAFF_SECRET, { expiresIn: '30d' }
    );
    delete staff.password_hash;
    res.json({ staff, token });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/staff', adminMiddleware, async (req, res) => {
  try {
    const r = await pool.query('SELECT id, name, email, role, level, created_at FROM staff ORDER BY level ASC, created_at ASC');
    res.json({ staff: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/staff/add', adminMiddleware, async (req, res) => {
  try {
    const { name, email, password, role } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'Namn, e-post och lösenord krävs' });
    const requestedRole = role || 'dispatcher';
    if (requestedRole === 'superadmin') return res.status(403).json({ error: 'Kan inte skapa superadmin' });
    if (requestedRole === 'admin' && req.staff.level > 1) return res.status(403).json({ error: 'Endast superadmin kan lägga till admins' });
    const level = requestedRole === 'admin' ? 2 : 3;
    const existing = await pool.query('SELECT id FROM staff WHERE email=$1', [email]);
    if (existing.rows.length > 0) return res.status(400).json({ error: 'E-postadressen används redan' });
    const hash = await bcrypt.hash(password, 10);
    const r = await pool.query(
      'INSERT INTO staff (name, email, password_hash, role, level) VALUES ($1,$2,$3,$4,$5) RETURNING id, name, email, role, level, created_at',
      [name, email, hash, requestedRole, level]
    );
    res.json({ staff: r.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/staff/change-password', staffMiddleware, async (req, res) => {
  try {
    const { current_password, new_password } = req.body;
    if (!current_password || !new_password) return res.status(400).json({ error: 'Ange nuvarande och nytt lösenord' });
    const r = await pool.query('SELECT * FROM staff WHERE id=$1', [req.staff.id]);
    const valid = await bcrypt.compare(current_password, r.rows[0].password_hash);
    if (!valid) return res.status(401).json({ error: 'Fel nuvarande lösenord' });
    const hash = await bcrypt.hash(new_password, 10);
    await pool.query('UPDATE staff SET password_hash=$1 WHERE id=$2', [hash, req.staff.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/staff/:id', adminMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, email, password, role } = req.body;
    const target = await pool.query('SELECT * FROM staff WHERE id=$1', [id]);
    if (!target.rows.length) return res.status(404).json({ error: 'Hittades inte' });
    const newLevel = role === 'superadmin' ? 1 : role === 'admin' ? 2 : 3;
    if (password) {
      const hash = await bcrypt.hash(password, 10);
      await pool.query(
        'UPDATE staff SET name=COALESCE($1,name), email=COALESCE($2,email), password_hash=$3, role=COALESCE($4,role), level=$5 WHERE id=$6',
        [name, email, hash, role, newLevel, id]
      );
    } else {
      await pool.query(
        'UPDATE staff SET name=COALESCE($1,name), email=COALESCE($2,email), role=COALESCE($3,role), level=$4 WHERE id=$5',
        [name, email, role, newLevel, id]
      );
    }
    const r = await pool.query('SELECT id, name, email, role, level, created_at FROM staff WHERE id=$1', [id]);
    res.json({ staff: r.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/staff/:id', adminMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    if (parseInt(id) === req.staff.id) return res.status(400).json({ error: 'Du kan inte ta bort ditt eget konto' });
    const target = await pool.query('SELECT level FROM staff WHERE id=$1', [id]);
    if (!target.rows.length) return res.status(404).json({ error: 'Hittades inte' });
    if (target.rows[0].level === 1) return res.status(403).json({ error: 'Kan inte ta bort superadmin' });
    await pool.query('DELETE FROM staff WHERE id=$1', [id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/bookings', async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT b.*, d.name as driver_name, d.plate as driver_plate FROM bookings b LEFT JOIN drivers d ON b.driver_id=d.id ORDER BY b.created_at DESC'
    );
    res.json({ bookings: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/my-bookings', authMiddleware, async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT b.*, d.name as driver_name, d.plate as driver_plate FROM bookings b LEFT JOIN drivers d ON b.driver_id=d.id WHERE b.customer_id=$1 ORDER BY b.created_at DESC',
      [req.customer.id]
    );
    res.json({ bookings: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/bookings', async (req, res) => {
  try {
    const { customer_name, customer_phone, customer_email, from_address, to_address,
      payment_method, fare_sek, scheduled_at, booking_type, customer_id,
      passengers, child_seat, child_age, driver_note, is_guest, guest_promo_accepted } = req.body;

    // Add columns if they don't exist (safe idempotent)
    await pool.query('ALTER TABLE bookings ADD COLUMN IF NOT EXISTS customer_email VARCHAR(200)').catch(()=>{});
    await pool.query('ALTER TABLE bookings ADD COLUMN IF NOT EXISTS is_guest BOOLEAN DEFAULT false').catch(()=>{});
    await pool.query('ALTER TABLE bookings ADD COLUMN IF NOT EXISTS guest_promo_accepted BOOLEAN DEFAULT false').catch(()=>{});

    // Save promo preference for guest
    if (is_guest && guest_promo_accepted && customer_email) {
      await pool.query(
        `INSERT INTO promo_subscriptions (email, phone, name, source, created_at)
         VALUES ($1,$2,$3,'guest_booking',NOW())
         ON CONFLICT (email) DO UPDATE SET phone=$2, name=$3`,
        [customer_email, customer_phone || null, customer_name || null]
      ).catch(()=>{}); // table may not exist yet - that's ok
    }

    // If guest booking, try to link to existing customer account by email
    let resolvedCustomerId = customer_id || null;
    if (is_guest && customer_email && !resolvedCustomerId) {
      const existing = await pool.query(
        'SELECT id FROM customers WHERE email=$1', [customer_email]
      );
      if (existing.rows.length) {
        resolvedCustomerId = existing.rows[0].id;
        console.log('Guest booking linked to existing customer:', resolvedCustomerId);
      }
    }

    const ref = 'W-' + Date.now().toString().slice(-6);
    const r = await pool.query(
      `INSERT INTO bookings (booking_ref, customer_name, customer_phone, customer_email,
        from_address, to_address, payment_method, fare_sek, scheduled_at, booking_type,
        customer_id, passengers, child_seat, child_age, driver_note, is_guest, guest_promo_accepted)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
      [ref, customer_name, customer_phone, customer_email||null,
       from_address, to_address, payment_method, fare_sek,
       scheduled_at||null, booking_type||'now', resolvedCustomerId,
       passengers||1, child_seat||false, child_age||null, driver_note||null,
       is_guest||false, guest_promo_accepted||false]
    );
    const booking = r.rows[0];
    io.emit('booking:new', booking);

    // SMS confirmation
    if (booking.customer_phone) {
      sendSMS(booking.customer_phone,
        'Trollhättan Cab: Din bokning ' + booking.booking_ref + ' är mottagen! Vi hittar en förare åt dig. Från: ' + booking.from_address
      );
    }

    // Email confirmation
    if (customer_email) {
      const linkedNote = resolvedCustomerId && is_guest
        ? '<p style="background:#dbeafe;border-radius:8px;padding:12px;color:#1a56db;font-size:13px">✅ Bokningen är kopplad till ditt konto. Logga in för att följa resan.</p>'
        : '';
      await sendEmail(
        customer_email,
        'Bokningsbekräftelse ' + ref + ' — Trollhättan Cab',
        `<div style="font-family:Arial,sans-serif;max-width:500px;margin:0 auto">
          <div style="background:#0d1b3e;padding:24px;border-radius:12px 12px 0 0;text-align:center">
            <div style="color:#fbbf24;font-size:22px;font-weight:800;letter-spacing:2px">🚖 TROLLHÄTTAN CAB</div>
          </div>
          <div style="background:white;padding:24px;border:1px solid #e2e8f0;border-radius:0 0 12px 12px">
            <h2 style="color:#0d1b3e;margin-bottom:4px">Bokning bekräftad!</h2>
            <div style="font-size:28px;font-weight:900;color:#1a56db;margin-bottom:20px;letter-spacing:2px">${ref}</div>
            <table style="width:100%;border-collapse:collapse;margin-bottom:16px">
              <tr style="background:#f8fafc"><td style="padding:10px;font-size:13px;color:#64748b">📍 Upphämtning</td><td style="padding:10px;font-size:13px;font-weight:600">${from_address}</td></tr>
              <tr><td style="padding:10px;font-size:13px;color:#64748b">🏁 Avlämning</td><td style="padding:10px;font-size:13px;font-weight:600">${to_address}</td></tr>
              <tr style="background:#f8fafc"><td style="padding:10px;font-size:13px;color:#64748b">💳 Betalning</td><td style="padding:10px;font-size:13px;font-weight:600">${payment_method}</td></tr>
              <tr><td style="padding:10px;font-size:13px;color:#64748b">💰 Pris</td><td style="padding:10px;font-size:13px;font-weight:700;color:#15803d">${fare_sek} kr</td></tr>
            </table>
            ${linkedNote}
            <p style="font-size:13px;color:#64748b">Du får ett SMS när din förare är på väg.</p>
            <p style="font-size:11px;color:#94a3b8;margin-top:20px">Trollhättan Cab AB · Lantmannavägen 20, 461 60 Trollhättan · info@trollhattancab.com</p>
          </div>
        </div>`
      );
    }

    res.json({ booking, customer_linked: !!resolvedCustomerId });
    notifyAvailableDrivers(booking);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── SIMPLE DISPATCH — notify all available drivers, first to accept wins ──
async function notifyAvailableDrivers(booking) {
  try {
    const r = await pool.query(
      "SELECT * FROM drivers WHERE status='available' AND blocked=false AND (suspended_until IS NULL OR suspended_until < NOW()) ORDER BY last_active ASC NULLS FIRST"
    );
    if (!r.rows.length) {
      io.emit('dispatch:status', {
        booking_id: booking.id,
        booking_ref: booking.booking_ref,
        message: '⚠️ Inga tillgängliga förare — tilldela manuellt',
        status: 'failed'
      });
      return;
    }
    // Store in pending dispatches for ALL available drivers
    // Each driver polls and first to accept wins
    r.rows.forEach(driver => {
      const payload = Object.assign({}, booking, { driver_id: driver.id, _auto: true });
      pendingDispatches.set(driver.id, { booking: payload, expires: Date.now() + 120000 });
      io.to('driver-' + driver.id).emit('booking:assigned:driver', payload);
    });
    io.emit('dispatch:status', {
      booking_id: booking.id,
      booking_ref: booking.booking_ref,
      message: '🔄 Söker förare... (' + r.rows.length + ' tillgängliga)',
      status: 'trying',
      queue_total: r.rows.length
    });
    // After 120 seconds if still pending — alert Central
    setTimeout(async () => {
      try {
        const check = await pool.query("SELECT status FROM bookings WHERE id=$1", [booking.id]);
        if (check.rows[0] && check.rows[0].status === 'pending') {
          io.emit('dispatch:failed', { booking_id: booking.id, booking_ref: booking.booking_ref, reason: 'Ingen förare accepterade — tilldela manuellt' });
        }
      } catch(e) {}
    }, 120000);
  } catch(e) { console.log('Dispatch error:', e.message); }
}

// Driver accepts booking — works for auto-dispatch AND manual assign
app.patch('/bookings/:id/accept', async (req, res) => {
  try {
    const { driver_id } = req.body;
    const { id } = req.params;
    const driverId = parseInt(driver_id);
    // Check booking
    const check = await pool.query("SELECT status, driver_id FROM bookings WHERE id=$1", [id]);
    if (!check.rows.length) return res.status(404).json({ error: 'Bokning hittades inte' });
    const b = check.rows[0];
    // Allow if: pending, OR already assigned to THIS driver
    if (b.status === 'cancelled') return res.status(409).json({ error: 'Bokning är avbokad' });
    if (b.status === 'completed') return res.status(409).json({ error: 'Bokning är redan avslutad' });
    if (b.status === 'assigned' && parseInt(b.driver_id) !== driverId) {
      return res.status(409).json({ error: 'Bokning är tilldelad annan förare' });
    }
    // Clear ALL pending dispatches for this booking
    pendingDispatches.forEach((val, key) => {
      if (val.booking && parseInt(val.booking.id) === parseInt(id)) {
        pendingDispatches.delete(key);
      }
    });
    // Assign to driver
    await pool.query("UPDATE bookings SET driver_id=$1, status='assigned', assigned_at=NOW() WHERE id=$2", [driverId, id]);
    await pool.query("UPDATE drivers SET status='busy', last_active=NOW() WHERE id=$1", [driverId]);
    const r = await pool.query(
      'SELECT b.*, d.name as driver_name, d.plate as driver_plate FROM bookings b LEFT JOIN drivers d ON b.driver_id=d.id WHERE b.id=$1', [id]
    );
    const booking = r.rows[0];
    io.emit('booking:assigned', booking);
    io.emit('dispatch:status', {
      booking_id: parseInt(id), booking_ref: booking.booking_ref,
      message: '✅ ' + booking.driver_name + ' accepterade', driver_name: booking.driver_name, status: 'accepted'
    });
    if (booking.customer_phone) {
      sendSMS(booking.customer_phone,
        'Trollhättan Cab: Din förare ' + booking.driver_name + ' är på väg! Bokning ' + booking.booking_ref + '. Skylt: ' + (booking.driver_plate||'')
      );
    }
    res.json({ success: true, booking });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/bookings/:id/assign', async (req, res) => {
  try {
    const { driver_id } = req.body;
    const { id } = req.params;
    await pool.query('UPDATE bookings SET driver_id=$1, status=\'assigned\', assigned_at=NOW() WHERE id=$2', [driver_id, id]);
    await pool.query('UPDATE drivers SET status=$1, last_active=NOW() WHERE id=$2', ['busy', driver_id]);
    const r = await pool.query(
      'SELECT b.*, d.name as driver_name, d.plate as driver_plate FROM bookings b LEFT JOIN drivers d ON b.driver_id=d.id WHERE b.id=$1', [id]
    );
    const booking = r.rows[0];
    io.emit('booking:assigned', booking);
    // Broadcast to all - driver app filters by own ID to avoid missing room
    io.emit('booking:assigned:driver', booking);
    if (booking.customer_phone) {
      sendSMS(booking.customer_phone,
        'Trollhättan Cab: Din förare ' + booking.driver_name + ' är på väg! Bokning ' + booking.booking_ref + '. Skylt: ' + (booking.driver_plate||'') + '. Frågor? Ring: 0520-000000'
      );
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/bookings/:id/decline', async (req, res) => {
  try {
    const { id } = req.params;
    const { driver_id } = req.body;
    // Return booking to pending
    await pool.query(
      'UPDATE bookings SET status=\'pending\', driver_id=NULL, assigned_at=NULL WHERE id=$1',
      [id]
    );
    // Block driver for 2 minutes
    if (driver_id) {
      const blockedUntil = new Date(Date.now() + 2 * 60 * 1000);
      await pool.query(
        'UPDATE drivers SET status=\'offline\', suspended_until=$1, suspend_reason=$2 WHERE id=$3',
        [blockedUntil, 'Avböjde bokning — tillfälligt blockerad 2 min', driver_id]
      );
      // Notify central
      io.emit('booking:declined', {
        bookingId: parseInt(id),
        driverId: driver_id
      });
      // Notify driver
      io.to('driver-' + driver_id).emit('driver:blocked', {
        until: blockedUntil,
        reason: 'Du avböjde en bokning. Du är blockerad i 2 minuter.'
      });
      // Unblock driver after 2 minutes
      setTimeout(async () => {
        try {
          await pool.query(
            'UPDATE drivers SET status=\'available\', suspended_until=NULL, suspend_reason=NULL WHERE id=$1',
            [driver_id]
          );
          io.emit('driver:status', { driverId: driver_id, status: 'available' });
          io.to('driver-' + driver_id).emit('driver:unblocked', {});
        } catch(e) { console.log('Unblock error:', e.message); }
      }, 2 * 60 * 1000);
    }
    // Return booking to central as pending
    const r = await pool.query('SELECT * FROM bookings WHERE id=$1', [id]);
    io.emit('booking:returned', r.rows[0]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/bookings/:id/complete', async (req, res) => {
  try {
    const { id } = req.params;
    const { driver_id, fare } = req.body;
    await pool.query('UPDATE bookings SET status=\'completed\', payment_status=\'pending\' WHERE id=$1', [id]);
    if (driver_id) {
      await pool.query(
        'UPDATE drivers SET status=\'available\', trips_today=trips_today+1, earnings_today=earnings_today+$1, last_active=NOW() WHERE id=$2',
        [fare || 0, driver_id]
      );
    }
    const r = await pool.query(
      'SELECT b.*, d.name as driver_name FROM bookings b LEFT JOIN drivers d ON b.driver_id=d.id WHERE b.id=$1', [id]
    );
    io.emit('booking:completed', r.rows[0]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/bookings/:id/cancel', async (req, res) => {
  try {
    const { id } = req.params;
    const b = await pool.query('SELECT * FROM bookings WHERE id=$1', [id]);
    if (b.rows[0]?.driver_id) {
      await pool.query('UPDATE drivers SET status=$1 WHERE id=$2', ['available', b.rows[0].driver_id]);
      io.to('driver-' + b.rows[0].driver_id).emit('booking:cancelled', { id: parseInt(id) });
    }
    await pool.query('UPDATE bookings SET status=\'cancelled\', driver_id=NULL WHERE id=$1', [id]);
    io.emit('booking:cancelled', { id: parseInt(id) });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/bookings/:id/cancel-request', async (req, res) => {
  try {
    const { id } = req.params;
    const { customer_name } = req.body;
    await pool.query('UPDATE bookings SET cancel_request=true, contacted_support=true WHERE id=$1', [id]);
    io.to('central').emit('booking:cancelRequest', { bookingId: id, customerName: customer_name });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/drivers', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM drivers ORDER BY name');
    res.json({ drivers: r.rows.map(d => ({ ...d, live_position: driverPositions[d.id] || null })) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Driver polls this every 3 seconds to check for pending booking
app.get('/drivers/:id/pending-booking', async (req, res) => {
  try {
    const driverId = parseInt(req.params.id);
    // Check pending dispatch cache first
    const pending = pendingDispatches.get(driverId);
    if (pending && pending.expires > Date.now()) {
      return res.json({ booking: pending.booking });
    }
    // Check database for bookings assigned to this driver that need acceptance
    // This covers manual Central assigns
    const r = await pool.query(
      "SELECT * FROM bookings WHERE driver_id=$1 AND status='assigned' AND assigned_at > NOW() - INTERVAL '5 minutes' ORDER BY created_at DESC LIMIT 1",
      [driverId]
    );
    if (r.rows.length) {
      return res.json({ booking: r.rows[0] });
    }
    res.json({ booking: null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/drivers/:id', staffMiddleware, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM drivers WHERE id=$1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Förare hittades inte' });
    const d = r.rows[0];
    delete d.password_hash;
    const bookings = await pool.query(
      'SELECT * FROM bookings WHERE driver_id=$1 ORDER BY created_at DESC LIMIT 20', [req.params.id]
    );
    res.json({ driver: d, recent_bookings: bookings.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/drivers/:id/manage', adminMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { action, reason, suspend_until, is_owner, owner_share, name, phone, plate, taxi_nr, city, password } = req.body;
    if (action === 'block') {
      await pool.query('UPDATE drivers SET blocked=true WHERE id=$1', [id]);
    } else if (action === 'unblock') {
      await pool.query('UPDATE drivers SET blocked=false, suspended_until=NULL, suspend_reason=NULL WHERE id=$1', [id]);
      io.to('driver-' + id).emit('driver:unblocked', {});
      io.emit('driver:status', { driverId: parseInt(id), status: 'available' });
    } else if (action === 'suspend') {
      await pool.query('UPDATE drivers SET suspended_until=$1, suspend_reason=$2 WHERE id=$3', [suspend_until||null, reason||null, id]);
    } else if (action === 'lift_block') {
      await pool.query(
        'UPDATE drivers SET suspended_until=NULL, suspend_reason=NULL WHERE id=$1', [id]
      );
      io.to('driver-' + id).emit('driver:unblocked', {});
      io.emit('driver:status', { driverId: parseInt(id), status: 'available' });
    } else if (action === 'remove_owner') {
      await pool.query('UPDATE drivers SET is_owner=false, owner_share=0 WHERE id=$1', [id]);
    } else if (action === 'update') {
      if (password) {
        const hash = await bcrypt.hash(password, 10);
        await pool.query(
          'UPDATE drivers SET name=COALESCE($1,name), phone=COALESCE($2,phone), plate=COALESCE($3,plate), taxi_nr=COALESCE($4,taxi_nr), city=COALESCE($5,city), password_hash=$6 WHERE id=$7',
          [name, phone, plate, taxi_nr, city, hash, id]
        );
      } else {
        await pool.query(
          'UPDATE drivers SET name=COALESCE($1,name), phone=COALESCE($2,phone), plate=COALESCE($3,plate), taxi_nr=COALESCE($4,taxi_nr), city=COALESCE($5,city) WHERE id=$6',
          [name, phone, plate, taxi_nr, city, id]
        );
      }
    }
    const r = await pool.query('SELECT * FROM drivers WHERE id=$1', [id]);
    const d = r.rows[0]; delete d.password_hash;
    res.json({ driver: d });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/drivers/add', adminMiddleware, async (req, res) => {
  try {
    const { name, email, phone, plate, taxi_nr, city, password, taxi_license } = req.body;
    if (!name || !email || !phone || !plate) return res.status(400).json({ error: 'Obligatoriska fält saknas' });
    const existing = await pool.query('SELECT id FROM drivers WHERE email=$1 OR plate=$2', [email, plate]);
    if (existing.rows.length > 0) return res.status(400).json({ error: 'E-post eller skylt används redan' });
    const hash = await bcrypt.hash(password || 'thtcab123', 10);
    const r = await pool.query(
      "INSERT INTO drivers (name, email, phone, plate, taxi_nr, city, password_hash, taxi_license, status, rating, trips_today, earnings_today) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'offline',5.0,0,0) RETURNING *",
      [name, email, phone, plate, taxi_nr||null, city||null, hash, taxi_license||null]
    );
    const d = r.rows[0]; delete d.password_hash;
    res.json({ driver: d });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/drivers/login', async (req, res) => {
  try {
    const { email, password, taxi_license, pin } = req.body;
    let driver;
    // Support both login methods
    if (taxi_license) {
      // New method: license + pin
      const r = await pool.query('SELECT * FROM drivers WHERE taxi_license=$1', [taxi_license]);
      if (!r.rows.length) return res.status(401).json({ error: 'Taxiförarlegitimation hittades inte' });
      driver = r.rows[0];
      if (driver.blocked) return res.status(403).json({ error: 'Ditt konto är blockerat. Kontakta central.' });
      if (driver.suspended_until && new Date(driver.suspended_until) > new Date()) {
        return res.status(403).json({ error: 'Ditt konto är avstängt till ' + new Date(driver.suspended_until).toLocaleDateString('sv-SE') });
      }
      // Check pin — use pin_hash if set, otherwise last 4 digits of license
      let validPin = false;
      if (driver.pin_hash) {
        validPin = await bcrypt.compare(pin, driver.pin_hash);
      } else {
        // Default PIN = last 4 digits of license
        const defaultPin = taxi_license.slice(-4);
        validPin = pin === defaultPin;
      }
      if (!validPin) return res.status(401).json({ error: 'Fel PIN-kod' });
    } else if (email && password) {
      // Legacy method: email + password
      const r = await pool.query('SELECT * FROM drivers WHERE email=$1', [email]);
      if (!r.rows.length) return res.status(401).json({ error: 'Fel e-post eller lösenord' });
      driver = r.rows[0];
      if (driver.blocked) return res.status(403).json({ error: 'Ditt konto är blockerat. Kontakta central.' });
      if (driver.suspended_until && new Date(driver.suspended_until) > new Date()) {
        return res.status(403).json({ error: 'Ditt konto är avstängt till ' + new Date(driver.suspended_until).toLocaleDateString('sv-SE') });
      }
      if (!driver.password_hash) return res.status(401).json({ error: 'Inget lösenord satt' });
      const valid = await bcrypt.compare(password, driver.password_hash);
      if (!valid) return res.status(401).json({ error: 'Fel e-post eller lösenord' });
    } else {
      return res.status(400).json({ error: 'Ange legitimationsnummer + PIN eller e-post + lösenord' });
    }
    // Get company info
    let companyName = null, akeriNumber = null;
    if (driver.company_id) {
      const comp = await pool.query('SELECT name, akeri_number FROM companies WHERE id=$1', [driver.company_id]);
      if (comp.rows.length) {
        companyName = comp.rows[0].name;
        akeriNumber = comp.rows[0].akeri_number;
      }
    }
    await pool.query('UPDATE drivers SET last_active=NOW() WHERE id=$1', [driver.id]);
    const token = jwt.sign({ id: driver.id, email: driver.email, name: driver.name }, JWT_SECRET, { expiresIn: '30d' });
    delete driver.password_hash;
    delete driver.pin_hash;
    res.json({ driver: { ...driver, company_name: companyName, akeri_number: akeriNumber }, token });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/customers', adminMiddleware, async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT id, name, email, phone, customer_type, preferred_payment, blocked, block_reason, created_at FROM customers ORDER BY created_at DESC'
    );
    res.json({ customers: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/customers/:id/manage', adminMiddleware, async (req, res) => {
  try {
    const { id } = req.params;
    const { action, reason, new_password } = req.body;
    if (action === 'block') {
      await pool.query('UPDATE customers SET blocked=true, block_reason=$1 WHERE id=$2', [reason||null, id]);
    } else if (action === 'unblock') {
      await pool.query('UPDATE customers SET blocked=false, block_reason=NULL WHERE id=$1', [id]);
    } else if (action === 'reset_password') {
      if (!new_password) return res.status(400).json({ error: 'Nytt lösenord krävs' });
      const hash = await bcrypt.hash(new_password, 10);
      await pool.query('UPDATE customers SET password_hash=$1 WHERE id=$2', [hash, id]);
    }
    const r = await pool.query('SELECT id, name, email, phone, customer_type, blocked, block_reason FROM customers WHERE id=$1', [id]);
    res.json({ customer: r.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/customers/register', async (req, res) => {
  try {
    const { name, phone, email, password, customer_type, org_number, billing_address, preferred_payment, home_address, work_address } = req.body;
    if (!name || !phone || !email || !password) return res.status(400).json({ error: 'Namn, telefon, e-post och lösenord krävs' });
    const existing = await pool.query('SELECT id FROM customers WHERE email=$1', [email]);
    if (existing.rows.length > 0) return res.status(400).json({ error: 'E-postadressen används redan' });
    const hash = await bcrypt.hash(password, 10);
    const r = await pool.query(
      'INSERT INTO customers (name, phone, email, password_hash, customer_type, org_number, billing_address, preferred_payment, home_address, work_address, profile_initial) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id, name, email, phone, customer_type, preferred_payment, profile_initial, created_at',
      [name, phone, email, hash, customer_type||'private', org_number||null, billing_address||null, preferred_payment||'swish', home_address||null, work_address||null, name.charAt(0).toUpperCase()]
    );
    const customer = r.rows[0];
    const token = jwt.sign({ id: customer.id, email: customer.email, name: customer.name }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ customer, token });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/customers/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'E-post och lösenord krävs' });
    const r = await pool.query('SELECT * FROM customers WHERE email=$1', [email]);
    if (!r.rows.length) return res.status(401).json({ error: 'Fel e-post eller lösenord' });
    const customer = r.rows[0];
    if (customer.blocked) return res.status(403).json({ error: 'Ditt konto är blockerat. Kontakta support.' });
    const valid = await bcrypt.compare(password, customer.password_hash);
    if (!valid) return res.status(401).json({ error: 'Fel e-post eller lösenord' });
    const token = jwt.sign({ id: customer.id, email: customer.email, name: customer.name }, JWT_SECRET, { expiresIn: '30d' });
    delete customer.password_hash;
    res.json({ customer, token });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/customers/profile', authMiddleware, async (req, res) => {
  try {
    const r = await pool.query(
      'SELECT id, name, email, phone, customer_type, org_number, billing_address, preferred_payment, home_address, work_address, other_address, profile_initial, created_at FROM customers WHERE id=$1',
      [req.customer.id]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Kund hittades inte' });
    res.json({ customer: r.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/customers/profile', authMiddleware, async (req, res) => {
  try {
    const { name, phone, preferred_payment, home_address, work_address, other_address, org_number, billing_address } = req.body;
    await pool.query(
      'UPDATE customers SET name=COALESCE($1,name), phone=COALESCE($2,phone), preferred_payment=COALESCE($3,preferred_payment), home_address=COALESCE($4,home_address), work_address=COALESCE($5,work_address), other_address=COALESCE($6,other_address), org_number=COALESCE($7,org_number), billing_address=COALESCE($8,billing_address) WHERE id=$9',
      [name, phone, preferred_payment, home_address, work_address, other_address, org_number, billing_address, req.customer.id]
    );
    const r = await pool.query(
      'SELECT id, name, email, phone, customer_type, org_number, billing_address, preferred_payment, home_address, work_address, other_address, profile_initial FROM customers WHERE id=$1',
      [req.customer.id]
    );
    res.json({ customer: r.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/customers/change-password', authMiddleware, async (req, res) => {
  try {
    const { current_password, new_password } = req.body;
    if (!current_password || !new_password) return res.status(400).json({ error: 'Ange nuvarande och nytt lösenord' });
    const r = await pool.query('SELECT * FROM customers WHERE id=$1', [req.customer.id]);
    const valid = await bcrypt.compare(current_password, r.rows[0].password_hash);
    if (!valid) return res.status(401).json({ error: 'Fel nuvarande lösenord' });
    const hash = await bcrypt.hash(new_password, 10);
    await pool.query('UPDATE customers SET password_hash=$1 WHERE id=$2', [hash, req.customer.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/bookings/:id/rate', authMiddleware, async (req, res) => {
  try {
    const { rating } = req.body;
    const b = await pool.query('SELECT * FROM bookings WHERE id=$1', [req.params.id]);
    if (b.rows[0]?.driver_id) {
      const d = await pool.query('SELECT rating FROM drivers WHERE id=$1', [b.rows[0].driver_id]);
      const newRating = ((d.rows[0].rating * 10) + rating) / 11;
      await pool.query('UPDATE drivers SET rating=$1 WHERE id=$2', [newRating.toFixed(2), b.rows[0].driver_id]);
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/messages/:threadKey', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM messages WHERE thread_key=$1 ORDER BY created_at ASC', [req.params.threadKey]);
    res.json({ messages: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/messages', async (req, res) => {
  try {
    const { thread_key, sender_name, sender_role, content } = req.body;
    const r = await pool.query(
      'INSERT INTO messages (thread_key, sender_name, sender_role, content) VALUES ($1,$2,$3,$4) RETURNING *',
      [thread_key, sender_name, sender_role, content]
    );
    io.emit('message:new:' + r.rows[0].thread_key, r.rows[0]);
    res.json({ message: r.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/drivers/queue', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, name, plate, taxi_nr, city, rating, trips_today, earnings_today, status, last_active
       FROM drivers
       WHERE status='available' AND (blocked=false OR blocked IS NULL)
       AND (suspended_until IS NULL OR suspended_until < NOW())
       ORDER BY last_active ASC`
    );
    res.json({ queue: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/test-gps', (req, res) => {
  const { driverId, lat, lng } = req.body;
  driverPositions[driverId] = { lat, lng, updatedAt: new Date() };
  io.emit('driver:location', { driverId, lat, lng });
  res.json({ status: 'ok' });
});

io.on('connection', (socket) => {
  console.log('Connected: ' + socket.id);
  socket.on('central:join', () => { socket.join('central'); console.log('Central joined'); });
  socket.on('driver:join', (driverId) => {
    socket.join('driver-' + driverId);
    console.log('Driver joined: driver-' + driverId);
    // Check if there is a pending dispatch for this driver
    const pending = pendingDispatches.get(parseInt(driverId));
    if (pending && pending.expires > Date.now()) {
      console.log('Resending pending dispatch to driver', driverId);
      setTimeout(() => {
        socket.emit('booking:assigned:driver', pending.booking);
      }, 500);
    }
  });
  socket.on('customer:join', (bookingId) => { socket.join('booking-' + bookingId); });
  socket.on('driver:location', async (data) => {
    const { driverId, lat, lng } = data;
    driverPositions[driverId] = { lat, lng, updatedAt: new Date() };
    try { await pool.query('UPDATE drivers SET lat=$1, lng=$2, last_active=NOW() WHERE id=$3', [lat, lng, driverId]); }
    catch (err) { console.log('GPS error: ' + err.message); }
    io.to('central').emit('driver:location', { driverId, lat, lng });
    io.emit('driver:location:' + driverId, { driverId, lat, lng });
  });
  socket.on('driver:status', async (data) => {
    const { driverId, status } = data;
    try {
      await pool.query('UPDATE drivers SET status=$1 WHERE id=$2', [status, driverId]);
      io.emit('driver:status', { driverId, status });
    } catch (err) { console.log('Status error: ' + err.message); }
  });
  socket.on('disconnect', () => { console.log('Disconnected: ' + socket.id); });
});

// Driver sends status message to customer
app.post('/bookings/:id/driver-message', async (req, res) => {
  try {
    const { message, phone } = req.body;
    if (phone && message) sendSMS(phone, message);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── STRIPE PAYMENT ROUTES ──

// Create payment intent for card payment
app.post('/payments/create-intent', async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Betalning ej konfigurerad' });
  try {
    const { amount, booking_ref, customer_email } = req.body;
    if (!amount || amount < 10) return res.status(400).json({ error: 'Ogiltigt belopp' });
    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100), // Convert SEK to öre
      currency: 'sek',
      metadata: { booking_ref: booking_ref || '', customer_email: customer_email || '' },
      automatic_payment_methods: { enabled: true },
    });
    res.json({
      client_secret: paymentIntent.client_secret,
      payment_intent_id: paymentIntent.id
    });
  } catch (err) {
    console.error('Stripe error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Confirm payment and update booking
app.post('/payments/confirm', async (req, res) => {
  if (!stripe) return res.status(503).json({ error: 'Betalning ej konfigurerad' });
  try {
    const { payment_intent_id, booking_id } = req.body;
    const intent = await stripe.paymentIntents.retrieve(payment_intent_id);
    if (intent.status === 'succeeded') {
      await pool.query(
        'UPDATE bookings SET payment_status=$1 WHERE id=$2',
        ['paid', booking_id]
      );
      res.json({ success: true, status: 'paid' });
    } else {
      res.json({ success: false, status: intent.status });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get payment status for a booking
app.get('/payments/status/:bookingId', async (req, res) => {
  try {
    const r = await pool.query('SELECT payment_status, payment_method, fare_sek, booking_ref FROM bookings WHERE id=$1', [req.params.bookingId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Bokning hittades inte' });
    res.json(r.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Stripe webhook
app.post('/payments/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const event = stripe.webhooks.constructEvent(
      req.body,
      req.headers['stripe-signature'],
      process.env.STRIPE_WEBHOOK_SECRET || ''
    );
    if (event.type === 'payment_intent.succeeded') {
      const intent = event.data.object;
      const ref = intent.metadata.booking_ref;
      if (ref) {
        await pool.query('UPDATE bookings SET payment_status=$1 WHERE booking_ref=$2', ['paid', ref]);
        console.log('Payment confirmed for', ref);
      }
    }
    res.json({ received: true });
  } catch (err) {
    console.error('Webhook error:', err.message);
    res.status(400).json({ error: err.message });
  }
});

// ── COMPANIES ROUTES ──

app.get('/companies', staffMiddleware, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM companies ORDER BY created_at DESC');
    res.json({ companies: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/companies/add', adminMiddleware, async (req, res) => {
  try {
    const { name, org_number, contact_email, contact_phone, agreement_date, notes } = req.body;
    const { akeri_number } = req.body;
    if (!name || !org_number) return res.status(400).json({ error: 'Namn och org.nr krävs' });
    const r = await pool.query(
      'INSERT INTO companies (name, org_number, contact_email, contact_phone, agreement_date, notes, status, akeri_number) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
      [name, org_number, contact_email||null, contact_phone||null, agreement_date||null, notes||null, 'active', akeri_number||null]
    );
    res.json({ company: r.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/companies/:id', adminMiddleware, async (req, res) => {
  try {
    const { name, org_number, contact_email, contact_phone, agreement_date, notes, status } = req.body;
    const r = await pool.query(
      'UPDATE companies SET name=$1, org_number=$2, contact_email=$3, contact_phone=$4, agreement_date=$5, notes=$6, status=$7 WHERE id=$8 RETURNING *',
      [name, org_number, contact_email, contact_phone, agreement_date, notes, status, req.params.id]
    );
    res.json({ company: r.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/companies/:id', adminMiddleware, async (req, res) => {
  try {
    await pool.query('UPDATE drivers SET company_id=NULL WHERE company_id=$1', [req.params.id]);
    await pool.query('DELETE FROM companies WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Assign driver to company
app.patch('/companies/:id/assign-driver', adminMiddleware, async (req, res) => {
  try {
    const { driver_id } = req.body;
    await pool.query('UPDATE drivers SET company_id=$1 WHERE id=$2', [req.params.id, driver_id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── ECONOMY ROUTES ──

app.get('/economy/summary', staffMiddleware, async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const [todayR, weekR, monthR, driversR] = await Promise.all([
      pool.query("SELECT COUNT(*) as bookings, COALESCE(SUM(fare_sek),0) as revenue FROM bookings WHERE status='completed' AND DATE(created_at)=$1", [today]),
      pool.query("SELECT COUNT(*) as bookings, COALESCE(SUM(fare_sek),0) as revenue FROM bookings WHERE status='completed' AND created_at >= NOW() - INTERVAL '7 days'"),
      pool.query("SELECT COUNT(*) as bookings, COALESCE(SUM(fare_sek),0) as revenue FROM bookings WHERE status='completed' AND created_at >= NOW() - INTERVAL '30 days'"),
      pool.query("SELECT d.id, d.name, d.plate, d.owner_share, d.is_owner, COALESCE(SUM(b.fare_sek),0) as earnings, COUNT(b.id) as trips FROM drivers d LEFT JOIN bookings b ON b.driver_id=d.id AND b.status='completed' AND b.created_at >= NOW() - INTERVAL '30 days' GROUP BY d.id ORDER BY earnings DESC"),
    ]);
    res.json({
      today: todayR.rows[0],
      week: weekR.rows[0],
      month: monthR.rows[0],
      drivers: driversR.rows
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/economy/bookings', staffMiddleware, async (req, res) => {
  try {
    const { from, to, status } = req.query;
    let q = "SELECT b.*, d.name as driver_name FROM bookings b LEFT JOIN drivers d ON b.driver_id=d.id WHERE 1=1";
    const params = [];
    if (from) { params.push(from); q += ` AND DATE(b.created_at) >= $${params.length}`; }
    if (to) { params.push(to); q += ` AND DATE(b.created_at) <= $${params.length}`; }
    if (status) { params.push(status); q += ` AND b.status = $${params.length}`; }
    q += ' ORDER BY b.created_at DESC LIMIT 500';
    const r = await pool.query(q, params);
    res.json({ bookings: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// ── CARS ROUTES ──

app.get('/cars', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT c.*, co.name as company_name, co.akeri_number,
        d.name as current_driver_name, d.taxi_license as current_driver_license
      FROM cars c
      LEFT JOIN companies co ON c.company_id = co.id
      LEFT JOIN drivers d ON c.current_driver_id = d.id
      ORDER BY c.created_at DESC
    `);
    res.json({ cars: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/cars/company/:companyId', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT c.*, d.name as current_driver_name
      FROM cars c
      LEFT JOIN drivers d ON c.current_driver_id = d.id
      WHERE c.company_id = $1
      ORDER BY c.plate
    `, [req.params.companyId]);
    res.json({ cars: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/cars/add', adminMiddleware, async (req, res) => {
  try {
    const { plate, model, year, color, taxi_nr, company_id } = req.body;
    if (!plate) return res.status(400).json({ error: 'Registreringsskylt krävs' });
    const r = await pool.query(
      'INSERT INTO cars (plate, model, year, color, taxi_nr, company_id) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [plate.toUpperCase(), model||null, year||null, color||null, taxi_nr||null, company_id||null]
    );
    res.json({ car: r.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/cars/:id', adminMiddleware, async (req, res) => {
  try {
    const { plate, model, year, color, taxi_nr, company_id } = req.body;
    const r = await pool.query(
      'UPDATE cars SET plate=COALESCE($1,plate), model=$2, year=$3, color=$4, taxi_nr=$5, company_id=$6 WHERE id=$7 RETURNING *',
      [plate, model, year, color, taxi_nr, company_id, req.params.id]
    );
    res.json({ car: r.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/cars/:id', adminMiddleware, async (req, res) => {
  try {
    await pool.query('DELETE FROM driver_cars WHERE car_id=$1', [req.params.id]);
    await pool.query('DELETE FROM cars WHERE id=$1', [req.params.id]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Assign driver to car (authorize)
app.post('/cars/:id/assign-driver', adminMiddleware, async (req, res) => {
  try {
    const { driver_id } = req.body;
    await pool.query(
      'INSERT INTO driver_cars (driver_id, car_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [driver_id, req.params.id]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Remove driver from car
app.delete('/cars/:id/driver/:driverId', adminMiddleware, async (req, res) => {
  try {
    await pool.query('DELETE FROM driver_cars WHERE car_id=$1 AND driver_id=$2', [req.params.id, req.params.driverId]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Driver selects car for current session
app.post('/cars/:id/select', async (req, res) => {
  try {
    const { driver_id } = req.body;
    const carId = req.params.id;
    // Verify driver is authorized for this car
    const auth = await pool.query('SELECT 1 FROM driver_cars WHERE driver_id=$1 AND car_id=$2', [driver_id, carId]);
    if (!auth.rows.length) return res.status(403).json({ error: 'Föraren är inte behörig för detta fordon' });
    // Release car from any other driver
    await pool.query("UPDATE cars SET current_driver_id=NULL, status='offline' WHERE current_driver_id=$1", [driver_id]);
    // Assign to this car
    await pool.query("UPDATE cars SET current_driver_id=$1, status='available', last_active=NOW() WHERE id=$2", [driver_id, carId]);
    // Update driver with car plate
    const car = await pool.query('SELECT * FROM cars WHERE id=$1', [carId]);
    io.emit('car:status', { carId: parseInt(carId), status: 'available', driverId: driver_id });
    res.json({ success: true, car: car.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Get cars available for a driver
app.get('/drivers/:id/cars', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT c.*, co.name as company_name
      FROM cars c
      JOIN driver_cars dc ON c.id = dc.car_id
      LEFT JOIN companies co ON c.company_id = co.id
      WHERE dc.driver_id = $1
      ORDER BY c.plate
    `, [req.params.id]);
    res.json({ cars: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Update car GPS location
app.post('/cars/:id/location', async (req, res) => {
  try {
    const { lat, lng } = req.body;
    await pool.query('UPDATE cars SET lat=$1, lng=$2, last_active=NOW() WHERE id=$3', [lat, lng, req.params.id]);
    io.emit('car:location', { carId: parseInt(req.params.id), lat, lng });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});



// ── DRIVER LOGOUT / SET OFFLINE ──
app.patch('/drivers/:id/go-offline', authMiddleware, async (req, res) => {
  try {
    const id = req.params.id;
    await pool.query("UPDATE drivers SET status='offline' WHERE id=$1", [id]);
    io.emit('driver:status', { driverId: parseInt(id), status: 'offline' });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});


// ── DRIVER ARRIVED AT PICKUP ──
app.post('/bookings/:id/arrived', async (req, res) => {
  try {
    const { driver_id } = req.body;
    await pool.query(
      "UPDATE bookings SET trip_phase='arrived', arrived_at=NOW() WHERE id=$1",
      [req.params.id]
    ).catch(async () => {
      await pool.query("ALTER TABLE bookings ADD COLUMN IF NOT EXISTS trip_phase VARCHAR(20) DEFAULT 'driving'");
      await pool.query('ALTER TABLE bookings ADD COLUMN IF NOT EXISTS arrived_at TIMESTAMP');
      await pool.query('ALTER TABLE bookings ADD COLUMN IF NOT EXISTS customer_in_at TIMESTAMP');
      await pool.query("UPDATE bookings SET trip_phase='arrived', arrived_at=NOW() WHERE id=$1", [req.params.id]);
    });
    // Get booking for SMS
    const r = await pool.query('SELECT * FROM bookings WHERE id=$1', [req.params.id]);
    const booking = r.rows[0];
    if (booking && booking.customer_phone) {
      sendSMS(booking.customer_phone,
        'Trollhättan Cab: Din förare är nu framme vid upphämtningsplatsen. Ref: ' + booking.booking_ref
      );
    }
    io.emit('booking:arrived', { booking_id: parseInt(req.params.id), driver_id });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── CUSTOMER IN CAR ──
app.post('/bookings/:id/customer-in', async (req, res) => {
  try {
    await pool.query(
      "UPDATE bookings SET trip_phase='customer_in', customer_in_at=NOW() WHERE id=$1",
      [req.params.id]
    ).catch(() => {});
    io.emit('booking:customer_in', { booking_id: parseInt(req.params.id) });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── DRIVER LOCATION UPDATE ──
app.patch('/drivers/:id/location', async (req, res) => {
  try {
    const { lat, lng } = req.body;
    if (!lat || !lng) return res.status(400).json({ error: 'lat and lng required' });
    await pool.query('UPDATE drivers SET lat=$1, lng=$2 WHERE id=$3', [lat, lng, req.params.id]);
    io.emit('driver:location', { driver_id: parseInt(req.params.id), lat, lng });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── CREATE / UPDATE AKERI PORTAL ACCESS ──
app.post('/staff/create-portal-access', adminMiddleware, async (req, res) => {
  try {
    const { email, password, company_id, company_name } = req.body;
    if (!email || !password || !company_id) return res.status(400).json({ error: 'Missing fields' });
    const hash = await bcrypt.hash(password, 10);
    const r = await pool.query(
      `INSERT INTO staff (name, email, password_hash, role, level, company_id)
       VALUES ($1,$2,$3,'akeri',4,$4)
       ON CONFLICT (email) DO UPDATE
       SET password_hash=$3, company_id=$4, role='akeri', level=4, name=$1
       RETURNING id, name, email, role, level, company_id`,
      [company_name + ' (Akeri)', email, hash, company_id]
    );
    // portal_email column ensured on startup
    await pool.query('UPDATE companies SET portal_email=$1 WHERE id=$2', [email, company_id]);
    res.json({ success: true, staff: r.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── ADJUST BOOKING PAYMENT ──
app.patch('/bookings/:id/adjust-payment', adminMiddleware, async (req, res) => {
  try {
    const { type, adjusted_fare, reason, extra_charge, extra_description, refund_amount, refund_reason } = req.body;
    // columns ensured on startup

    let query, params;
    if (type === 'correction') {
      query = 'UPDATE bookings SET adjusted_fare=$1, correction_reason=$2 WHERE id=$3 RETURNING *';
      params = [adjusted_fare, reason, req.params.id];
    } else if (type === 'extra') {
      query = 'UPDATE bookings SET extra_charge=COALESCE(extra_charge,0)+$1, extra_description=$2, adjusted_fare=COALESCE(adjusted_fare,fare_sek,0)+$1 WHERE id=$3 RETURNING *';
      params = [extra_charge, extra_description, req.params.id];
    } else if (type === 'refund') {
      query = "UPDATE bookings SET refund_amount=$1, refund_reason=$2, payment_status='refunded' WHERE id=$3 RETURNING *";
      params = [refund_amount, refund_reason, req.params.id];
    } else {
      return res.status(400).json({ error: 'Invalid type' });
    }
    const r = await pool.query(query, params);
    res.json({ success: true, booking: r.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── GET COMPANY BY ID ──
app.get('/companies/:id', staffMiddleware, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM companies WHERE id=$1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ company: r.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── ECONOMY SUMMARY ──
app.get('/economy/summary', staffMiddleware, async (req, res) => {
  try {
    const today = new Date().toISOString().split('T')[0];
    const weekAgo = new Date(Date.now()-7*24*60*60*1000).toISOString().split('T')[0];
    const monthAgo = new Date(Date.now()-30*24*60*60*1000).toISOString().split('T')[0];
    const [tR,wR,mR,dR] = await Promise.all([
      pool.query("SELECT COUNT(*) as bookings, COALESCE(SUM(fare_sek),0) as revenue FROM bookings WHERE status='completed' AND created_at::date=$1",[today]),
      pool.query("SELECT COUNT(*) as bookings, COALESCE(SUM(fare_sek),0) as revenue FROM bookings WHERE status='completed' AND created_at::date>=$1",[weekAgo]),
      pool.query("SELECT COUNT(*) as bookings, COALESCE(SUM(fare_sek),0) as revenue FROM bookings WHERE status='completed' AND created_at::date>=$1",[monthAgo]),
      pool.query("SELECT d.id,d.name,d.plate,d.taxi_nr,d.is_owner,d.owner_share,COUNT(b.id) as trips,COALESCE(SUM(b.fare_sek),0) as earnings FROM drivers d LEFT JOIN bookings b ON b.driver_id=d.id AND b.status='completed' AND b.created_at::date>=$1 GROUP BY d.id ORDER BY earnings DESC",[monthAgo])
    ]);
    res.json({ today:tR.rows[0], week:wR.rows[0], month:mR.rows[0], drivers:dR.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── ECONOMY BOOKINGS ──
app.get('/economy/bookings', staffMiddleware, async (req, res) => {
  try {
    const { from, to, status, limit=200 } = req.query;
    let where=[], params=[];
    if (from) { params.push(from); where.push('b.created_at::date>=$'+params.length); }
    if (to)   { params.push(to);   where.push('b.created_at::date<=$'+params.length); }
    if (status){ params.push(status); where.push('b.status=$'+params.length); }
    params.push(parseInt(limit));
    const r = await pool.query(
      'SELECT b.*,d.name as driver_name,c.name as customer_name,c.phone as customer_phone FROM bookings b LEFT JOIN drivers d ON b.driver_id=d.id LEFT JOIN customers c ON b.customer_id=c.id '+(where.length?'WHERE '+where.join(' AND '):'')+' ORDER BY b.created_at DESC LIMIT $'+params.length,
      params
    );
    res.json({ bookings: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── ADD MISSING COLUMNS ON STARTUP ──
async function ensureColumns() {
  const cols = [
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS customer_email VARCHAR(200)",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS is_guest BOOLEAN DEFAULT false",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS guest_promo_accepted BOOLEAN DEFAULT false",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS trip_phase VARCHAR(20) DEFAULT 'driving'",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS arrived_at TIMESTAMP",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS customer_in_at TIMESTAMP",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS adjusted_fare INTEGER",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS extra_charge INTEGER DEFAULT 0",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS refund_amount INTEGER DEFAULT 0",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS correction_reason TEXT",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS refund_reason TEXT",
    "ALTER TABLE bookings ADD COLUMN IF NOT EXISTS extra_description TEXT",
    "ALTER TABLE companies ADD COLUMN IF NOT EXISTS portal_email VARCHAR(200)",
    `CREATE TABLE IF NOT EXISTS promo_subscriptions (
      id SERIAL PRIMARY KEY,
      email VARCHAR(200) UNIQUE NOT NULL,
      phone VARCHAR(50),
      name VARCHAR(200),
      source VARCHAR(50) DEFAULT 'guest_booking',
      created_at TIMESTAMP DEFAULT NOW()
    )`,
  ];
  for (const q of cols) {
    try { await pool.query(q); } catch(e) { console.log('Column setup:', e.message); }
  }
  console.log('✅ Database columns verified');
}
// Wait for columns before accepting requests
ensureColumns().then(() => {

server.listen(PORT, () => {
  console.log('Trollhattan Cab API v5.5 on port ' + PORT);
  console.log('Socket.io ready');
});

}); // end ensureColumns().then
