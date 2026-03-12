// server.js (2.4.1 + WebSocket + Security)
import express from 'express';
import http from 'http';
import https from 'https';
import { WebSocketServer } from 'ws';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import morgan from 'morgan';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { db, ensureInitialized } from './src/db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const HTTPS_PORT = process.env.HTTPS_PORT || 3443;

app.use(helmet({ contentSecurityPolicy:false }));
app.use(express.json());
app.use(morgan('dev'));
app.use(cors({ origin:false }));

// =============================================================================
// RATE LIMITING
// =============================================================================

// Strict rate limit for login endpoint (prevent brute force)
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // 10 attempts per 15 minutes
  message: { error: 'Zu viele Login-Versuche. Bitte versuchen Sie es später erneut.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// General API rate limit
const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 100, // 100 requests per minute
  message: { error: 'Zu viele Anfragen. Bitte versuchen Sie es später erneut.' },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    // Skip rate limiting for GET requests to non-sensitive endpoints
    return req.method === 'GET' && !req.path.includes('/api/system');
  }
});

// Apply rate limiters
app.use('/api/auth/login', loginLimiter);
app.use('/api/', apiLimiter);

// Logging middleware
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    if (req.method !== 'GET' || req.path.startsWith('/api/system')) {
      log('info', 'api', `${req.method} ${req.path}`, { status: res.statusCode, duration: `${duration}ms` });
    }
  });
  next();
});

ensureInitialized();
db.pragma('foreign_keys=ON');

const ok = (res, data={}) => res.json({ ok:true, ...data });

// System Logging
const systemLog = [];
const MAX_LOG_ENTRIES = 200;

function log(level, category, message, data = null) {
  const entry = {
    id: Date.now() + Math.random(),
    timestamp: new Date().toISOString(),
    level, // 'info', 'warning', 'error'
    category, // 'api', 'db', 'session', 'order', 'system'
    message,
    data
  };
  systemLog.push(entry);
  if (systemLog.length > MAX_LOG_ENTRIES) systemLog.shift();

  // Console output
  const prefix = `[${level.toUpperCase()}] ${category}:`;
  if (level === 'error') console.error(prefix, message, data || '');
  else if (level === 'warning') console.warn(prefix, message, data || '');
  else console.log(prefix, message, data || '');

  return entry;
}

// =============================================================================
// INPUT VALIDATION SCHEMAS (Zod)
// =============================================================================

const loginSchema = z.object({
  role: z.enum(['waiter', 'bar', 'admin']),
  pin: z.string().regex(/^\d{4,8}$/).optional(),
});

const orderSchema = z.object({
  table_id: z.number().int().positive(),
  waiter: z.string().min(1).max(100),
  items: z.array(z.union([
    z.number().int().positive(),
    z.object({
      product_id: z.number().int().positive(),
      comment: z.string().max(500).nullable().optional(),
    }),
  ])).min(1),
});

const productSchema = z.object({
  name: z.string().min(1).max(200),
  price: z.number().positive(),
  color: z.string().max(20).nullable().optional(),
  active: z.boolean().optional(),
  half: z.boolean().optional(),
  station: z.string().max(100).nullable().optional(),
});

const pinUpdateSchema = z.object({
  pin_bar: z.string().regex(/^\d{4,8}$/).optional(),
  pin_admin: z.string().regex(/^\d{4,8}$/).optional(),
}).refine(data => data.pin_bar || data.pin_admin, {
  message: 'At least one PIN required'
});

// Validation middleware factory
function validate(schema) {
  return (req, res, next) => {
    try {
      req.body = schema.parse(req.body);
      next();
    } catch (error) {
      if (error instanceof z.ZodError) {
        const messages = error.errors.map(e => `${e.path.join('.')}: ${e.message}`).join(', ');
        log('warning', 'validation', 'Validation failed', { path: req.path, errors: messages });
        return res.status(400).json({ error: 'Validierungsfehler', details: messages });
      }
      next(error);
    }
  };
}

function readConfigMap(){
  const rows = db.prepare('SELECT key,value FROM config').all();
  return Object.fromEntries(rows.map(r => [r.key, JSON.parse(r.value)]));
}
function writeConfigEntry(key,val){
  db.prepare('INSERT INTO config(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(val));
}

app.get('/health', (_req,res)=> res.json({ ok:true, version:'2.4.1', time:new Date().toISOString() }));

// Config
app.get('/api/config', (_req,res)=> res.json(readConfigMap()));
app.put('/api/config', (req,res)=>{ const tx=db.transaction(entries=>{ for(const [k,v] of entries) writeConfigEntry(k,v); }); tx(Object.entries(req.body||{})); broadcast('config:updated', readConfigMap()); return ok(res); });

// Authentication & PINs
// Master PIN is loaded from environment variable for security
// Set MASTER_PIN environment variable or use default for development only
const MASTER_PIN = process.env.MASTER_PIN || '22822282';

app.post('/api/auth/login', validate(loginSchema), (req, res) => {
  const { role, pin } = req.body;

  if (!role) {
    return res.status(400).json({ error: 'role required' });
  }

  // Waiter role doesn't need PIN
  if (role === 'waiter') {
    return res.json({ success: true });
  }

  // Bar and Admin roles require PIN
  if (!pin) {
    return res.status(401).json({ error: 'PIN required' });
  }

  // Check Master PIN (works for all roles)
  if (pin === MASTER_PIN) {
    log('info', 'auth', `Login successful with Master PIN`, { role });
    return res.json({ success: true, master: true });
  }

  // Check role-specific PIN
  const pinKey = role === 'bar' ? 'pin_bar' : 'pin_admin';
  const storedPin = db.prepare('SELECT value FROM settings WHERE key=?').get(pinKey);

  if (!storedPin || storedPin.value !== pin) {
    log('warning', 'auth', `Login failed - invalid PIN`, { role });
    return res.status(401).json({ error: 'Ungültige PIN' });
  }

  log('info', 'auth', `Login successful`, { role });
  res.json({ success: true });
});

app.get('/api/settings/pins', (_req, res) => {
  // Return masked PINs for display in Admin UI
  const pinBar = db.prepare('SELECT value FROM settings WHERE key=?').get('pin_bar');
  const pinAdmin = db.prepare('SELECT value FROM settings WHERE key=?').get('pin_admin');

  res.json({
    pin_bar: pinBar ? pinBar.value : '****',
    pin_admin: pinAdmin ? pinAdmin.value : '****'
  });
});

app.put('/api/settings/pins', validate(pinUpdateSchema), (req, res) => {
  const { pin_bar, pin_admin } = req.body;

  const tx = db.transaction(() => {
    if (pin_bar) {
      // Validate PIN format (4-8 digits)
      if (!/^\d{4,8}$/.test(pin_bar)) {
        throw new Error('Theke-PIN muss 4-8 Ziffern enthalten');
      }
      db.prepare('UPDATE settings SET value=? WHERE key=?').run(pin_bar, 'pin_bar');
      log('info', 'settings', 'Theke-PIN changed');
    }

    if (pin_admin) {
      // Validate PIN format (4-8 digits)
      if (!/^\d{4,8}$/.test(pin_admin)) {
        throw new Error('Admin-PIN muss 4-8 Ziffern enthalten');
      }
      db.prepare('UPDATE settings SET value=? WHERE key=?').run(pin_admin, 'pin_admin');
      log('info', 'settings', 'Admin-PIN changed');
    }
  });

  try {
    tx();
    res.json({ success: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Products
function getProductsList(){ const rows=db.prepare('SELECT id,name,price_cents,active,color,half,station FROM products').all(); const order=(readConfigMap().product_order)||[]; const idx=new Map(order.map((id,i)=>[id,i])); rows.sort((a,b)=>((idx.get(a.id)??1e9)-(idx.get(b.id)??1e9))||(a.id-b.id)); return rows.map(p=>({...p,price:p.price_cents/100})); }
app.get('/api/products', (_req,res)=>{
  const rows=db.prepare('SELECT id,name,price_cents,active,color,half,station FROM products').all();
  const order=(readConfigMap().product_order)||[];
  const idx=new Map(order.map((id,i)=>[id,i]));
  rows.sort((a,b) => ((idx.get(a.id) ?? 1e9) - (idx.get(b.id) ?? 1e9)) || (a.id - b.id));
  res.json(rows.map(p=>({ ...p, price: p.price_cents/100 })));
});
app.post('/api/products', validate(productSchema), (req,res)=>{
  const {name,price,color,active=true,half=false,station=null}=req.body;
  const info=db.prepare('INSERT INTO products(name,price_cents,active,color,half,station) VALUES(?,?,?,?,?,?)').run(name, Math.round(price*100), active?1:0, color||null, half?1:0, station);
  const out=db.prepare('SELECT id,name,price_cents,active,color,half,station FROM products WHERE id=?').get(info.lastInsertRowid);
  const order=(readConfigMap().product_order)||[]; order.push(out.id); writeConfigEntry('product_order',order);
  broadcast('products:updated', getProductsList());
  res.status(201).json({ ...out, price: out.price_cents/100 });
});
app.put('/api/products/order', (req,res)=>{
  const arr=(req.body&&Array.isArray(req.body.order))?req.body.order.map(x=>+x):null;
  if(!arr) return res.status(400).json({error:'order[] required'});
  const ids=db.prepare('SELECT id FROM products').all().map(r=>r.id);
  writeConfigEntry('product_order', arr.filter(id=>ids.includes(id)));
  broadcast('products:updated', getProductsList());
  return ok(res);
});
app.put('/api/products/:id', (req,res)=>{
  const id=+req.params.id; const cur=db.prepare('SELECT * FROM products WHERE id=?').get(id); if(!cur) return res.status(404).json({error:'not found'});
  const {name,price,active,color,half,station}=req.body||{};
  db.prepare('UPDATE products SET name=?, price_cents=?, active=?, color=?, half=?, station=? WHERE id=?')
    .run(name??cur.name, price!==undefined?Math.round(price*100):cur.price_cents, active!==undefined?(active?1:0):cur.active, color!==undefined?color:cur.color, half!==undefined?(half?1:0):cur.half, station!==undefined?station:cur.station, id);
  const out=db.prepare('SELECT id,name,price_cents,active,color,half,station FROM products WHERE id=?').get(id);
  broadcast('products:updated', getProductsList());
  res.json({ ...out, price: out.price_cents/100 });
});
app.delete('/api/products/:id', (req,res)=>{
  const id=+req.params.id;
  db.prepare('DELETE FROM products WHERE id=?').run(id);
  const order=(readConfigMap().product_order)||[];
  writeConfigEntry('product_order',order.filter(x=>x!==id));
  broadcast('products:updated', getProductsList());
  return ok(res);
});

// Tables
app.get('/api/tables', (_req,res)=> res.json(db.prepare('SELECT id,name FROM tables ORDER BY id').all()));
app.post('/api/tables', (req,res)=>{ const info=db.prepare('INSERT INTO tables(name) VALUES(?)').run(req.body?.name||null); broadcast('tables:updated', db.prepare('SELECT id,name FROM tables ORDER BY id').all()); res.status(201).json(db.prepare('SELECT id,name FROM tables WHERE id=?').get(info.lastInsertRowid)); });
app.delete('/api/tables/:id', (req,res)=>{ db.prepare('DELETE FROM tables WHERE id=?').run(+req.params.id); broadcast('tables:updated', db.prepare('SELECT id,name FROM tables ORDER BY id').all()); return ok(res); });

// Waiter Sessions
app.get('/api/sessions', (_req,res)=>{
  // Clean old sessions (older than 5 minutes)
  db.prepare("DELETE FROM waiter_sessions WHERE datetime(last_heartbeat) < datetime('now','-5 minutes')").run();
  const sessions=db.prepare('SELECT waiter, last_heartbeat FROM waiter_sessions ORDER BY waiter').all();
  res.json(sessions);
});
app.post('/api/sessions/heartbeat', (req,res)=>{
  const {waiter}=req.body||{};
  if(!waiter) return res.status(400).json({error:'waiter required'});

  // Check if this is a new session (first heartbeat = login)
  const existingSession = db.prepare('SELECT waiter FROM waiter_sessions WHERE waiter=?').get(waiter);
  const isNewSession = !existingSession;

  db.prepare('INSERT INTO waiter_sessions(waiter,last_heartbeat) VALUES(?,datetime(\'now\')) ON CONFLICT(waiter) DO UPDATE SET last_heartbeat=datetime(\'now\')').run(waiter);

  // 🚀 WebSocket: Only broadcast on new sessions (login), not on every heartbeat
  if (isNewSession) {
    const sessions = db.prepare('SELECT waiter, last_heartbeat FROM waiter_sessions ORDER BY waiter').all();
    broadcast('session:update', sessions);
    log('info', 'session', `New session created: ${waiter}`);
  }

  return ok(res);
});
app.delete('/api/sessions/:waiter', (req,res)=>{
  const waiter=req.params.waiter;
  db.prepare('DELETE FROM waiter_sessions WHERE waiter=?').run(waiter);
  log('info', 'session', `Session deleted: ${waiter}`);

  // 🚀 WebSocket: Bediener-Gerät zur Abmeldung auffordern
  broadcast('session:kicked', { waiter });

  // 🚀 WebSocket: Broadcast updated sessions
  const sessions = db.prepare('SELECT waiter, last_heartbeat FROM waiter_sessions ORDER BY waiter').all();
  broadcast('session:update', sessions);

  return ok(res);
});

// System Logs & Status
app.get('/api/system/logs', (_req,res)=>{
  res.json(systemLog.slice().reverse()); // Newest first
});

app.get('/api/system/status', (_req,res)=>{
  const orders=db.prepare('SELECT COUNT(*) as count FROM orders WHERE status!=\'paid\'').get();
  const orderItems=db.prepare('SELECT COUNT(*) as ready, COUNT(*) as total FROM order_items oi JOIN orders o ON o.id=oi.order_id WHERE o.status!=\'paid\'').get();
  const sessions=db.prepare('SELECT COUNT(*) as count FROM waiter_sessions').get();
  const products=db.prepare('SELECT COUNT(*) as count FROM products WHERE active=1').get();

  res.json({
    uptime: process.uptime(),
    orders: {
      open: orders.count,
      itemsReady: orderItems.ready,
      itemsTotal: orderItems.total
    },
    sessions: sessions.count,
    products: products.count,
    logEntries: systemLog.length,
    websocket: {
      connectedClients: wsClients.size,
      totalConnections: wsStats.totalConnections,
      totalDisconnects: wsStats.totalDisconnects,
      messagesSent: wsStats.messagesSent,
      messagesReceived: wsStats.messagesReceived,
      broadcastEvents: wsStats.broadcastEvents,
      uptime: Math.floor((Date.now() - wsStats.startTime) / 1000)
    },
    timestamp: new Date().toISOString()
  });
});

// Orders
app.get('/api/orders', (_req,res)=>{
  let orders=db.prepare('SELECT * FROM orders ORDER BY datetime(created_at) DESC').all();
  const itemsStmt=db.prepare('SELECT oi.id, oi.product_id, oi.ready, oi.paid, oi.comment, p.name, p.price_cents FROM order_items oi JOIN products p ON p.id=oi.product_id WHERE order_id=?');
  res.json(orders.map(o=>({ ...o, items: itemsStmt.all(o.id).map(i=>({ id:i.id, product_id:i.product_id, name:i.name, ready:!!i.ready, paid:!!i.paid, price:i.price_cents/100, comment:i.comment||null })) })));
});
app.post('/api/orders', validate(orderSchema), (req,res)=>{
  try{
    const {table_id, waiter, items}=req.body;
    const get=db.prepare('SELECT price_cents FROM products WHERE id=?');
    const priced=[];
    for(const item of items){
      const pid=typeof item==='object'?item.product_id:item;
      const comment=typeof item==='object'?item.comment:null;
      const r=get.get(pid);
      if(!r) return res.status(400).json({error:'invalid product id', pid});
      priced.push({pid,price_cents:r.price_cents,comment});
    }
    const tx=db.transaction(()=>{
      const info=db.prepare("INSERT INTO orders(table_id,waiter,status) VALUES(?,?,'open')").run(table_id, waiter);
      const ins=db.prepare('INSERT INTO order_items(order_id,product_id,ready,price_cents,comment) VALUES(?,?,0,?,?)');
      for(const {pid,price_cents,comment} of priced) ins.run(info.lastInsertRowid,pid,price_cents,comment);
      return info.lastInsertRowid;
    });
    const id=tx();
    // Calculate total from priced items
    const total_cents=priced.reduce((sum,p)=>sum+p.price_cents,0);

    // 🚀 WebSocket: Broadcast new order to all clients
    const newOrder = getOrderWithItems(id);
    if (newOrder) {
      broadcast('order:created', newOrder);
      log('info', 'order', `Order created: #${id}`, { table: table_id, waiter, items: items.length });
    }

    res.status(201).json({id, total_cents});
  }catch(e){ console.error('POST /api/orders failed:',e); res.status(500).json({error:'internal_error'}); }
});
app.patch('/api/orders/:id/items/:itemId/toggle-ready', (req,res)=>{
  const id=+req.params.id;
  const itemId=+req.params.itemId;
  const item=db.prepare('SELECT * FROM order_items WHERE id=? AND order_id=?').get(itemId,id);
  if(!item) return res.status(404).json({error:'item not found'});
  const nr=item.ready?0:1;
  db.prepare('UPDATE order_items SET ready=? WHERE id=?').run(nr,itemId);
  const flags=db.prepare('SELECT ready FROM order_items WHERE order_id=?').all(id).map(r=>!!r.ready);
  const status=(flags.length>0 && flags.every(Boolean))?'ready':'open';
  db.prepare('UPDATE orders SET status=? WHERE id=?').run(status,id);

  // 🚀 WebSocket: Broadcast updated order
  const updatedOrder = getOrderWithItems(id);
  if (updatedOrder) {
    broadcast('order:updated', updatedOrder);
  }

  return ok(res,{ready:!!nr,status});
});
app.post('/api/orders/:id/items/:itemId/ready', (req,res)=>{
  const id=+req.params.id;
  const itemId=+req.params.itemId;
  const item=db.prepare('SELECT * FROM order_items WHERE id=? AND order_id=?').get(itemId,id);
  if(!item) return res.status(404).json({error:'item not found'});
  db.prepare('UPDATE order_items SET ready=1 WHERE id=?').run(itemId);
  const flags=db.prepare('SELECT ready FROM order_items WHERE order_id=?').all(id).map(r=>!!r.ready);
  const status=(flags.length>0 && flags.every(Boolean))?'ready':'open';
  db.prepare('UPDATE orders SET status=? WHERE id=?').run(status,id);

  // 🚀 WebSocket: Broadcast updated order
  const updatedOrder = getOrderWithItems(id);
  if (updatedOrder) {
    broadcast('order:updated', updatedOrder);
  }

  return ok(res,{ready:true,status});
});
app.post('/api/orders/:id/ready', (req,res)=>{
  const id=+req.params.id;
  db.prepare('UPDATE order_items SET ready=1 WHERE order_id=?').run(id);
  db.prepare("UPDATE orders SET status='ready' WHERE id=?").run(id);

  // 🚀 WebSocket: Broadcast updated order
  const updatedOrder = getOrderWithItems(id);
  if (updatedOrder) {
    broadcast('order:updated', updatedOrder);
  }

  return ok(res);
});
app.post('/api/orders/:id/pickup', (req,res)=>{
  const id=+req.params.id;
  db.prepare("UPDATE orders SET status='picked' WHERE id=?").run(id);

  // 🚀 WebSocket: Broadcast updated order
  const updatedOrder = getOrderWithItems(id);
  if (updatedOrder) {
    broadcast('order:updated', updatedOrder);
  }

  return ok(res);
});
app.post('/api/orders/:id/pay', (req,res)=>{
  const orderId=+req.params.id;
  db.prepare("UPDATE orders SET status='paid' WHERE id=?").run(orderId);
  db.prepare("UPDATE order_items SET paid=1 WHERE order_id=?").run(orderId);

  // 🚀 WebSocket: Broadcast that order was paid
  broadcast('order:paid', { id: orderId });
  log('info', 'order', `Order paid: #${orderId}`);

  return ok(res);
});
app.post('/api/orders/:id/pay-items', (req,res)=>{
  const orderId=+req.params.id;
  const {itemIds}=req.body||{};
  if(!Array.isArray(itemIds)||itemIds.length===0) return res.status(400).json({error:'itemIds[] required'});

  const tx=db.transaction(()=>{
    itemIds.forEach(itemId=>{
      db.prepare('UPDATE order_items SET paid=1 WHERE id=? AND order_id=?').run(+itemId,orderId);
    });

    const allItems=db.prepare('SELECT paid FROM order_items WHERE order_id=?').all(orderId);
    const allPaid=allItems.length>0 && allItems.every(i=>i.paid===1);

    if(allPaid){
      db.prepare("UPDATE orders SET status='paid' WHERE id=?").run(orderId);
    }
  });

  tx();

  // 🚀 WebSocket: Broadcast updated order (or paid if all items paid)
  const order = db.prepare('SELECT status FROM orders WHERE id=?').get(orderId);
  if (order && order.status === 'paid') {
    broadcast('order:paid', { id: orderId });
  } else {
    const updatedOrder = getOrderWithItems(orderId);
    if (updatedOrder) {
      broadcast('order:updated', updatedOrder);
    }
  }

  return ok(res);
});

// Report
app.get('/api/report/summary', (_req,res)=>{ const sum=db.prepare('SELECT COALESCE(SUM(price_cents),0) AS cents FROM order_items').get(); const counts=db.prepare('SELECT p.name, COUNT(*) AS qty FROM order_items oi JOIN products p ON p.id=oi.product_id GROUP BY p.id ORDER BY qty DESC').all(); res.json({ total:(sum.cents||0)/100, products:counts }); });
app.post('/api/report/reset', (_req,res)=>{ const tx=db.transaction(()=>{ db.prepare('DELETE FROM order_items').run(); db.prepare('DELETE FROM orders').run(); }); tx(); return ok(res); });

app.use(express.static(path.join(__dirname,'public')));
app.get('*', (_req,res)=> res.sendFile(path.join(__dirname,'public','index.html')));

// =============================================================================
// WEBSOCKET SERVER SETUP
// =============================================================================

// Create HTTP Server (needed for WebSocket upgrade)
const httpServer = http.createServer(app);

// WebSocket Server
const wss = new WebSocketServer({ noServer: true });

// Store all connected clients
const wsClients = new Set();

// WebSocket statistics
const wsStats = {
  totalConnections: 0,
  totalDisconnects: 0,
  messagesSent: 0,
  messagesReceived: 0,
  broadcastEvents: {},
  startTime: Date.now()
};

// WebSocket connection handler
wss.on('connection', (ws, req) => {
  const clientIp = req.socket.remoteAddress;
  log('info', 'websocket', `Client connected`, { ip: clientIp });

  wsClients.add(ws);
  wsStats.totalConnections++;
  console.log(`[WebSocket] Client connected. Total clients: ${wsClients.size}`);

  // Send initial data to newly connected client
  try {
    const orders = db.prepare("SELECT * FROM orders WHERE status != 'paid' ORDER BY datetime(created_at) DESC").all();
    const itemsStmt = db.prepare('SELECT oi.id, oi.product_id, oi.ready, oi.paid, oi.comment, p.name, p.price_cents FROM order_items oi JOIN products p ON p.id=oi.product_id WHERE order_id=?');
    const ordersWithItems = orders.map(o => ({
      ...o,
      items: itemsStmt.all(o.id).map(i => ({
        id: i.id,
        product_id: i.product_id,
        name: i.name,
        ready: !!i.ready,
        paid: !!i.paid,
        price: i.price_cents / 100,
        comment: i.comment || null
      }))
    }));

    const sessions = db.prepare('SELECT waiter, last_heartbeat FROM waiter_sessions ORDER BY waiter').all();
    const products = db.prepare('SELECT id,name,price_cents,active,color,half,station FROM products').all().map(p => ({ ...p, price: p.price_cents / 100 }));

    ws.send(JSON.stringify({
      event: 'init',
      data: {
        orders: ordersWithItems,
        sessions,
        products
      },
      timestamp: new Date().toISOString()
    }));
  } catch (err) {
    console.error('[WebSocket] Error sending init data:', err);
  }

  // Handle messages from client
  ws.on('message', (message) => {
    wsStats.messagesReceived++;
    try {
      const data = JSON.parse(message.toString());
      console.log('[WebSocket] Message from client:', data);

      // Handle different message types if needed
      if (data.event === 'ping') {
        ws.send(JSON.stringify({ event: 'pong', timestamp: new Date().toISOString() }));
        wsStats.messagesSent++;
      }
    } catch (err) {
      console.error('[WebSocket] Error parsing message:', err);
    }
  });

  // Handle client disconnect
  ws.on('close', () => {
    wsClients.delete(ws);
    wsStats.totalDisconnects++;
    console.log(`[WebSocket] Client disconnected. Total clients: ${wsClients.size}`);
    log('info', 'websocket', `Client disconnected`, { remaining: wsClients.size });
  });

  // Handle errors
  ws.on('error', (error) => {
    console.error('[WebSocket] Error:', error);
    log('error', 'websocket', 'WebSocket error', { error: error.message });
  });
});

// Upgrade HTTP requests to WebSocket
httpServer.on('upgrade', (request, socket, head) => {
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
});

// Broadcast function: Send event to all connected clients
function broadcast(event, data) {
  if (wsClients.size === 0) return; // No clients connected

  const message = JSON.stringify({
    event,
    data,
    timestamp: new Date().toISOString()
  });

  let sentCount = 0;
  wsClients.forEach(client => {
    if (client.readyState === 1) { // 1 = OPEN
      try {
        client.send(message);
        sentCount++;
        wsStats.messagesSent++;
      } catch (err) {
        console.error('[WebSocket] Error sending to client:', err);
      }
    }
  });

  if (sentCount > 0) {
    // Track broadcast events by type
    wsStats.broadcastEvents[event] = (wsStats.broadcastEvents[event] || 0) + 1;
    console.log(`[WebSocket] Broadcasted '${event}' to ${sentCount} client(s)`);
  }
}

// Helper: Get full order with items
function getOrderWithItems(orderId) {
  const order = db.prepare('SELECT * FROM orders WHERE id=?').get(orderId);
  if (!order) return null;

  const items = db.prepare(`
    SELECT oi.id, oi.product_id, oi.ready, oi.paid, oi.comment, p.name, p.price_cents
    FROM order_items oi
    JOIN products p ON p.id=oi.product_id
    WHERE order_id=?
  `).all(orderId).map(i => ({
    id: i.id,
    product_id: i.product_id,
    name: i.name,
    ready: !!i.ready,
    paid: !!i.paid,
    price: i.price_cents / 100,
    comment: i.comment || null
  }));

  return { ...order, items };
}

// =============================================================================
// HTTP Server Start
// =============================================================================

httpServer.listen(PORT, () => {
  console.log(`Bestellsystem v2.4.1 on http://localhost:${PORT}`);
  console.log(`WebSocket server ready`);
  log('info', 'system', 'Server started with WebSocket support', { port: PORT, version: '2.4.1' });
});

// HTTPS Server (mit selbstsigniertem Zertifikat)
const certPath = path.join(__dirname, 'certs', 'server.crt');
const keyPath = path.join(__dirname, 'certs', 'server.key');

if(fs.existsSync(certPath) && fs.existsSync(keyPath)){
  const httpsOptions = {
    cert: fs.readFileSync(certPath),
    key: fs.readFileSync(keyPath)
  };
  https.createServer(httpsOptions, app).listen(HTTPS_PORT, ()=> {
    console.log(`HTTPS Server on https://localhost:${HTTPS_PORT}`);
  });
} else {
  console.log('HTTPS nicht verfügbar - Zertifikate fehlen in ./certs/');
}
