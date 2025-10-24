// server.js (2.3.20)
import express from 'express';
import https from 'https';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import morgan from 'morgan';
import helmet from 'helmet';
import cors from 'cors';
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

ensureInitialized();
db.pragma('foreign_keys=ON');

const ok = (res, data={}) => res.json({ ok:true, ...data });

function readConfigMap(){
  const rows = db.prepare('SELECT key,value FROM config').all();
  return Object.fromEntries(rows.map(r => [r.key, JSON.parse(r.value)]));
}
function writeConfigEntry(key,val){
  db.prepare('INSERT INTO config(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(val));
}

app.get('/health', (_req,res)=> res.json({ ok:true, version:'2.3.20', time:new Date().toISOString() }));

// Config
app.get('/api/config', (_req,res)=> res.json(readConfigMap()));
app.put('/api/config', (req,res)=>{ const tx=db.transaction(entries=>{ for(const [k,v] of entries) writeConfigEntry(k,v); }); tx(Object.entries(req.body||{})); return ok(res); });

// Products
app.get('/api/products', (_req,res)=>{
  const rows=db.prepare('SELECT id,name,price_cents,active,color,half FROM products').all();
  const order=(readConfigMap().product_order)||[]; 
  const idx=new Map(order.map((id,i)=>[id,i]));
  rows.sort((a,b) => ((idx.get(a.id) ?? 1e9) - (idx.get(b.id) ?? 1e9)) || (a.id - b.id));
  res.json(rows.map(p=>({ ...p, price: p.price_cents/100 })));
});
app.post('/api/products', (req,res)=>{
  const {name,price,color,active=true,half=false}=req.body||{}; 
  if(!name||typeof price!=='number') return res.status(400).json({error:'name & price required'});
  const info=db.prepare('INSERT INTO products(name,price_cents,active,color,half) VALUES(?,?,?,?,?)').run(name, Math.round(price*100), active?1:0, color||null, half?1:0);
  const out=db.prepare('SELECT id,name,price_cents,active,color,half FROM products WHERE id=?').get(info.lastInsertRowid);
  const order=(readConfigMap().product_order)||[]; order.push(out.id); writeConfigEntry('product_order',order);
  res.status(201).json({ ...out, price: out.price_cents/100 });
});
app.put('/api/products/:id', (req,res)=>{
  const id=+req.params.id; const cur=db.prepare('SELECT * FROM products WHERE id=?').get(id); if(!cur) return res.status(404).json({error:'not found'});
  const {name,price,active,color,half}=req.body||{};
  db.prepare('UPDATE products SET name=?, price_cents=?, active=?, color=?, half=? WHERE id=?')
    .run(name??cur.name, price!==undefined?Math.round(price*100):cur.price_cents, active!==undefined?(active?1:0):cur.active, color!==undefined?color:cur.color, half!==undefined?(half?1:0):cur.half, id);
  const out=db.prepare('SELECT id,name,price_cents,active,color,half FROM products WHERE id=?').get(id);
  res.json({ ...out, price: out.price_cents/100 });
});
app.delete('/api/products/:id', (req,res)=>{ 
  const id=+req.params.id;
  db.prepare('DELETE FROM products WHERE id=?').run(id); 
  const order=(readConfigMap().product_order)||[]; 
  writeConfigEntry('product_order',order.filter(x=>x!==id)); 
  return ok(res); 
});
app.put('/api/products/order', (req,res)=>{ 
  const arr=(req.body&&Array.isArray(req.body.order))?req.body.order.map(x=>+x):null; 
  if(!arr) return res.status(400).json({error:'order[] required'}); 
  const ids=db.prepare('SELECT id FROM products').all().map(r=>r.id); 
  writeConfigEntry('product_order', arr.filter(id=>ids.includes(id))); 
  return ok(res); 
});

// Tables
app.get('/api/tables', (_req,res)=> res.json(db.prepare('SELECT id,name FROM tables ORDER BY id').all()));
app.post('/api/tables', (req,res)=>{ const info=db.prepare('INSERT INTO tables(name) VALUES(?)').run(req.body?.name||null); res.status(201).json(db.prepare('SELECT id,name FROM tables WHERE id=?').get(info.lastInsertRowid)); });
app.delete('/api/tables/:id', (req,res)=>{ db.prepare('DELETE FROM tables WHERE id=?').run(+req.params.id); return ok(res); });

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
  db.prepare('INSERT INTO waiter_sessions(waiter,last_heartbeat) VALUES(?,datetime(\'now\')) ON CONFLICT(waiter) DO UPDATE SET last_heartbeat=datetime(\'now\')').run(waiter);
  return ok(res);
});
app.delete('/api/sessions/:waiter', (req,res)=>{
  const waiter=req.params.waiter;
  db.prepare('DELETE FROM waiter_sessions WHERE waiter=?').run(waiter);
  return ok(res);
});

// Orders
app.get('/api/orders', (_req,res)=>{
  let orders=db.prepare('SELECT * FROM orders ORDER BY datetime(created_at) DESC').all();
  const itemsStmt=db.prepare('SELECT oi.id, oi.product_id, oi.ready, oi.paid, p.name, p.price_cents FROM order_items oi JOIN products p ON p.id=oi.product_id WHERE order_id=?');
  res.json(orders.map(o=>({ ...o, items: itemsStmt.all(o.id).map(i=>({ id:i.id, product_id:i.product_id, name:i.name, ready:!!i.ready, paid:!!i.paid, price:i.price_cents/100 })) })));
});
app.post('/api/orders', (req,res)=>{
  try{ 
    const {table_id, waiter, items}=req.body||{}; 
    if(!table_id||!waiter||!Array.isArray(items)||items.length===0) return res.status(400).json({error:'table_id, waiter, items[] required'});
    const get=db.prepare('SELECT price_cents FROM products WHERE id=?');
    const priced=[]; for(const pid of items){ const r=get.get(pid); if(!r) return res.status(400).json({error:'invalid product id', pid}); priced.push({pid,price_cents:r.price_cents}); }
    const tx=db.transaction(()=>{ const info=db.prepare("INSERT INTO orders(table_id,waiter,status) VALUES(?,?,'open')").run(table_id, waiter); const ins=db.prepare('INSERT INTO order_items(order_id,product_id,ready,price_cents) VALUES(?,?,0,?)'); for(const {pid,price_cents} of priced) ins.run(info.lastInsertRowid,pid,price_cents); return info.lastInsertRowid; });
    const id=tx(); res.status(201).json({id});
  }catch(e){ console.error('POST /api/orders failed:',e); res.status(500).json({error:'internal_error'}); }
});
app.patch('/api/orders/:id/items/:itemId/toggle-ready', (req,res)=>{ const id=+req.params.id; const itemId=+req.params.itemId; const item=db.prepare('SELECT * FROM order_items WHERE id=? AND order_id=?').get(itemId,id); if(!item) return res.status(404).json({error:'item not found'}); const nr=item.ready?0:1; db.prepare('UPDATE order_items SET ready=? WHERE id=?').run(nr,itemId); const flags=db.prepare('SELECT ready FROM order_items WHERE order_id=?').all(id).map(r=>!!r.ready); const status=(flags.length>0 && flags.every(Boolean))?'ready':'open'; db.prepare('UPDATE orders SET status=? WHERE id=?').run(status,id); return ok(res,{ready:!!nr,status}); });
app.post('/api/orders/:id/items/:itemId/ready', (req,res)=>{
  const id=+req.params.id;
  const itemId=+req.params.itemId;
  const item=db.prepare('SELECT * FROM order_items WHERE id=? AND order_id=?').get(itemId,id);
  if(!item) return res.status(404).json({error:'item not found'});
  db.prepare('UPDATE order_items SET ready=1 WHERE id=?').run(itemId);
  const flags=db.prepare('SELECT ready FROM order_items WHERE order_id=?').all(id).map(r=>!!r.ready);
  const status=(flags.length>0 && flags.every(Boolean))?'ready':'open';
  db.prepare('UPDATE orders SET status=? WHERE id=?').run(status,id);
  return ok(res,{ready:true,status});
});
app.post('/api/orders/:id/ready', (req,res)=>{
  const id=+req.params.id;
  db.prepare('UPDATE order_items SET ready=1 WHERE order_id=?').run(id);
  db.prepare("UPDATE orders SET status='ready' WHERE id=?").run(id);
  return ok(res);
});
app.post('/api/orders/:id/pickup', (req,res)=>{ db.prepare("UPDATE orders SET status='picked' WHERE id=?").run(+req.params.id); return ok(res); });
app.post('/api/orders/:id/pay', (req,res)=>{ db.prepare("UPDATE orders SET status='paid' WHERE id=?").run(+req.params.id); return ok(res); });
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
  return ok(res);
});

// Report
app.get('/api/report/summary', (_req,res)=>{ const sum=db.prepare('SELECT COALESCE(SUM(price_cents),0) AS cents FROM order_items').get(); const counts=db.prepare('SELECT p.name, COUNT(*) AS qty FROM order_items oi JOIN products p ON p.id=oi.product_id GROUP BY p.id ORDER BY qty DESC').all(); res.json({ total:(sum.cents||0)/100, products:counts }); });
app.post('/api/report/reset', (_req,res)=>{ const tx=db.transaction(()=>{ db.prepare('DELETE FROM order_items').run(); db.prepare('DELETE FROM orders').run(); }); tx(); return ok(res); });

app.use(express.static(path.join(__dirname,'public')));
app.get('*', (_req,res)=> res.sendFile(path.join(__dirname,'public','index.html')));

// HTTP Server
app.listen(PORT, ()=> console.log(`Bestellsystem v2.3.20 on http://localhost:${PORT}`));

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
