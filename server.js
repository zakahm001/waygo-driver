const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET','POST','PATCH'] }
});

const PORT = 3000;
const JWT_SECRET = 'waygo-secret-2025';

app.use(cors({ origin: '*' }));
app.use(express.json());

const pool = new Pool({
  user: 'waygo_user',
  host: 'localhost',
  database: 'waygo',
  password: 'Waygo2025!',
  port: 5432,
});

const driverPositions = {};

function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'No token' });
  try { req.customer = jwt.verify(token, JWT_SECRET); next(); }
  catch (err) { res.status(401).json({ error: 'Invalid token' }); }
}

app.get('/', (req, res) => {
  res.json({ message: 'Waygo API running', status: 'ok',
    version: '5.1', database: 'connected', realtime: 'socket.io active' });
});

app.get('/bookings', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT b.*, d.name as driver_name, d.plate as driver_plate
       FROM bookings b LEFT JOIN drivers d ON b.driver_id=d.id
       ORDER BY b.created_at DESC`
    );
    res.json({ bookings: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/drivers', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM drivers ORDER BY name');
    const drivers = r.rows.map(d => ({
      ...d, live_position: driverPositions[d.id] || null
    }));
    res.json({ drivers });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/bookings', async (req, res) => {
  try {
    const { customer_name, customer_phone, from_address, to_address,
      payment_method, fare_sek, scheduled_at, booking_type } = req.body;
    const ref = 'W-' + Date.now().toString().slice(-6);
    const r = await pool.query(
      `INSERT INTO bookings (booking_ref, customer_name, customer_phone,
       from_address, to_address, payment_method, fare_sek,
       scheduled_at, booking_type)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [ref, customer_name, customer_phone, from_address, to_address,
       payment_method, fare_sek, scheduled_at||null, booking_type||'now']
    );
    const booking = r.rows[0];
    io.emit('booking:new', booking);
    res.json({ booking });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/bookings/:id/assign', async (req, res) => {
  try {
    const { driver_id } = req.body;
    const { id } = req.params;
    await pool.query(
      `UPDATE bookings SET driver_id=$1, status='assigned', assigned_at=NOW() WHERE id=$2`,
      [driver_id, id]
    );
    await pool.query('UPDATE drivers SET status=$1 WHERE id=$2', ['busy', driver_id]);
    const r = await pool.query(
      `SELECT b.*, d.name as driver_name, d.plate as driver_plate
       FROM bookings b LEFT JOIN drivers d ON b.driver_id=d.id WHERE b.id=$1`, [id]
    );
    const booking = r.rows[0];
    io.emit('booking:assigned', booking);
    io.to('driver-' + driver_id).emit('booking:assigned:driver', booking);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/bookings/:id/complete', async (req, res) => {
  try {
    const { id } = req.params;
    const { driver_id, fare } = req.body;
    await pool.query(
      `UPDATE bookings SET status='completed', payment_status='pending' WHERE id=$1`, [id]
    );
    if (driver_id) {
      await pool.query(
        `UPDATE drivers SET status='available', trips_today=trips_today+1,
         earnings_today=earnings_today+$1 WHERE id=$2`,
        [fare || 0, driver_id]
      );
    }
    const r = await pool.query(
      `SELECT b.*, d.name as driver_name FROM bookings b
       LEFT JOIN drivers d ON b.driver_id=d.id WHERE b.id=$1`, [id]
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
      await pool.query('UPDATE drivers SET status=$1 WHERE id=$2',
        ['available', b.rows[0].driver_id]);
      io.to('driver-' + b.rows[0].driver_id)
        .emit('booking:cancelled', { id: parseInt(id) });
    }
    await pool.query(
      `UPDATE bookings SET status='cancelled', driver_id=NULL WHERE id=$1`, [id]
    );
    io.emit('booking:cancelled', { id: parseInt(id) });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/bookings/:id/cancel-request', async (req, res) => {
  try {
    const { id } = req.params;
    const { customer_name } = req.body;
    await pool.query(
      `UPDATE bookings SET cancel_request=true, contacted_support=true WHERE id=$1`, [id]
    );
    io.to('central').emit('booking:cancelRequest',
      { bookingId: id, customerName: customer_name });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/bookings/:id/approve-cancel', async (req, res) => {
  try {
    const { id } = req.params;
    const { approve } = req.body;
    if (approve) {
      const b = await pool.query('SELECT * FROM bookings WHERE id=$1', [id]);
      if (b.rows[0]?.driver_id) {
        await pool.query('UPDATE drivers SET status=$1 WHERE id=$2',
          ['available', b.rows[0].driver_id]);
      }
      await pool.query(
        `UPDATE bookings SET status='cancelled', cancel_request=false,
         driver_id=NULL WHERE id=$1`, [id]
      );
      io.emit('booking:cancelled', { id: parseInt(id) });
    } else {
      await pool.query(
        'UPDATE bookings SET cancel_request=false WHERE id=$1', [id]
      );
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/payments/:id/update', async (req, res) => {
  try {
    const { id } = req.params;
    const { payment_status } = req.body;
    await pool.query(
      'UPDATE bookings SET payment_status=$1 WHERE id=$2', [payment_status, id]
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/drivers/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: 'E-post och lösenord krävs' });
    const r = await pool.query(
      'SELECT * FROM drivers WHERE email=$1', [email]
    );
    if (r.rows.length === 0)
      return res.status(401).json({ error: 'Fel e-post eller lösenord' });
    const driver = r.rows[0];
    if (!driver.password_hash)
      return res.status(401).json({ error: 'Inget lösenord satt' });
    const valid = await bcrypt.compare(password, driver.password_hash);
    if (!valid)
      return res.status(401).json({ error: 'Fel e-post eller lösenord' });
    const token = jwt.sign(
      { id: driver.id, email: driver.email, name: driver.name },
      JWT_SECRET, { expiresIn: '30d' }
    );
    delete driver.password_hash;
    res.json({ driver, token });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/customers/register', async (req, res) => {
  try {
    const { name, phone, email, password, customer_type,
      org_number, billing_address, preferred_payment,
      home_address, work_address } = req.body;
    if (!name || !phone || !email || !password)
      return res.status(400).json({ error: 'Namn, telefon, e-post och lösenord krävs' });
    const existing = await pool.query(
      'SELECT id FROM customers WHERE email=$1', [email]
    );
    if (existing.rows.length > 0)
      return res.status(400).json({ error: 'E-postadressen används redan' });
    const hash = await bcrypt.hash(password, 10);
    const initial = name.charAt(0).toUpperCase();
    const r = await pool.query(
      `INSERT INTO customers (name, phone, email, password_hash, customer_type,
       org_number, billing_address, preferred_payment, home_address, work_address,
       profile_initial)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING id, name, email, phone, customer_type, preferred_payment,
       profile_initial, created_at`,
      [name, phone, email, hash, customer_type||'private',
       org_number||null, billing_address||null,
       preferred_payment||'swish', home_address||null, work_address||null, initial]
    );
    const customer = r.rows[0];
    const token = jwt.sign(
      { id: customer.id, email: customer.email, name: customer.name },
      JWT_SECRET, { expiresIn: '30d' }
    );
    res.json({ customer, token });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/customers/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: 'E-post och lösenord krävs' });
    const r = await pool.query(
      'SELECT * FROM customers WHERE email=$1', [email]
    );
    if (r.rows.length === 0)
      return res.status(401).json({ error: 'Fel e-post eller lösenord' });
    const customer = r.rows[0];
    const valid = await bcrypt.compare(password, customer.password_hash);
    if (!valid)
      return res.status(401).json({ error: 'Fel e-post eller lösenord' });
    const token = jwt.sign(
      { id: customer.id, email: customer.email, name: customer.name },
      JWT_SECRET, { expiresIn: '30d' }
    );
    delete customer.password_hash;
    res.json({ customer, token });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/customers/profile', authMiddleware, async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT id, name, email, phone, customer_type, org_number,
       billing_address, preferred_payment, home_address, work_address,
       other_address, profile_initial, created_at
       FROM customers WHERE id=$1`, [req.customer.id]
    );
    if (r.rows.length === 0)
      return res.status(404).json({ error: 'Kund hittades inte' });
    res.json({ customer: r.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/customers/profile', authMiddleware, async (req, res) => {
  try {
    const { name, phone, preferred_payment, home_address,
      work_address, other_address, org_number, billing_address } = req.body;
    await pool.query(
      `UPDATE customers SET
       name=COALESCE($1,name), phone=COALESCE($2,phone),
       preferred_payment=COALESCE($3,preferred_payment),
       home_address=COALESCE($4,home_address),
       work_address=COALESCE($5,work_address),
       other_address=COALESCE($6,other_address),
       org_number=COALESCE($7,org_number),
       billing_address=COALESCE($8,billing_address)
       WHERE id=$9`,
      [name, phone, preferred_payment, home_address,
       work_address, other_address, org_number, billing_address, req.customer.id]
    );
    const r = await pool.query(
      `SELECT id, name, email, phone, customer_type, org_number,
       billing_address, preferred_payment, home_address, work_address,
       other_address, profile_initial FROM customers WHERE id=$1`,
      [req.customer.id]
    );
    res.json({ customer: r.rows[0] });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/bookings/:id/rate', authMiddleware, async (req, res) => {
  try {
    const { rating } = req.body;
    const { id } = req.params;
    const b = await pool.query('SELECT * FROM bookings WHERE id=$1', [id]);
    if (b.rows[0]?.driver_id) {
      const d = await pool.query(
        'SELECT rating FROM drivers WHERE id=$1', [b.rows[0].driver_id]
      );
      const newRating = ((d.rows[0].rating * 10) + rating) / 11;
      await pool.query('UPDATE drivers SET rating=$1 WHERE id=$2',
        [newRating.toFixed(2), b.rows[0].driver_id]);
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/messages/:threadKey', async (req, res) => {
  try {
    const r = await pool.query(
      `SELECT * FROM messages WHERE thread_key=$1 ORDER BY created_at ASC`,
      [req.params.threadKey]
    );
    res.json({ messages: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/messages', async (req, res) => {
  try {
    const { thread_key, sender_name, sender_role, content } = req.body;
    const r = await pool.query(
      `INSERT INTO messages (thread_key, sender_name, sender_role, content)
       VALUES ($1,$2,$3,$4) RETURNING *`,
      [thread_key, sender_name, sender_role, content]
    );
    io.emit('message:new:' + r.rows[0].thread_key, r.rows[0]);
    res.json({ message: r.rows[0] });
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
  socket.on('central:join', () => {
    socket.join('central');
    console.log('Central joined');
  });
  socket.on('driver:join', (driverId) => {
    socket.join('driver-' + driverId);
    console.log('Driver joined room: driver-' + driverId);
  });
  socket.on('customer:join', (bookingId) => {
    socket.join('booking-' + bookingId);
  });
  socket.on('driver:location', async (data) => {
    const { driverId, lat, lng } = data;
    driverPositions[driverId] = { lat, lng, updatedAt: new Date() };
    try {
      await pool.query(
        'UPDATE drivers SET lat=$1, lng=$2 WHERE id=$3', [lat, lng, driverId]
      );
    } catch (err) { console.log('GPS error: ' + err.message); }
    io.to('central').emit('driver:location', { driverId, lat, lng });
    io.emit('driver:location:' + driverId, { driverId, lat, lng });
  });
  socket.on('driver:status', async (data) => {
    const { driverId, status } = data;
    try {
      await pool.query(
        'UPDATE drivers SET status=$1 WHERE id=$2', [status, driverId]
      );
      io.emit('driver:status', { driverId, status });
    } catch (err) { console.log('Status error: ' + err.message); }
  });
  socket.on('disconnect', () => {
    console.log('Disconnected: ' + socket.id);
  });
});

server.listen(PORT, () => {
  console.log('Waygo API v5.1 on port ' + PORT);
  console.log('Socket.io ready');
});
ENDOFFILE
echo "Done. Lines: $(wc -l < /mnt/user-data/outputs/server.js)"