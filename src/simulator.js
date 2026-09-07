// src/simulator.js
// Server-seitiger Last-/Workflow-Simulator. Erzeugt virtuelle Bediener mit
// realistischen Order-/Theke-/Kasse-Mustern direkt ueber die DB.
//
// Eingebrachte Marker: virtuelle Bediener heissen "SIM_<n>" (POS: "SIM_POS"),
// dadurch ist sauberer Cleanup ueber LIKE 'SIM_%' moeglich.

function randomInt(min, max){
  return Math.floor(min + Math.random() * (max - min + 1));
}

export class Simulator {
  constructor(deps){
    this.db = deps.db;
    this.broadcast = deps.broadcast;
    this.getOrderWithItems = deps.getOrderWithItems;
    this.log = deps.log;

    this.timers = new Set();
    this.waiters = [];
    this.state = {
      running: false,
      browserMode: false,
      config: null,
      startedAt: null,
      stats: this.emptyStats(),
    };
  }

  emptyStats(){
    return {
      ordersCreated: 0,
      itemsCreated: 0,
      itemsReady: 0,
      itemsPicked: 0,
      itemsPaid: 0,
      itemsCancelled: 0,
      ordersPaid: 0,
      errors: 0,
    };
  }

  setTimer(fn, ms){
    const id = setTimeout(() => {
      this.timers.delete(id);
      try { fn(); } catch(e){ this.state.stats.errors++; this.log('error','simulator', e.message); }
    }, ms);
    this.timers.add(id);
    return id;
  }

  isRunning(){ return this.state.running; }

  getStatus(){
    return {
      running:      this.state.running,
      config:       this.state.config,
      startedAt:    this.state.startedAt,
      uptimeSec:    this.state.startedAt ? Math.floor((Date.now() - this.state.startedAt)/1000) : 0,
      stats:        { ...this.state.stats },
      activeWaiters:this.waiters.filter(w=>w.active).length,
    };
  }

  start(config){
    if(this.state.running) throw new Error('Simulator laeuft bereits');

    // Defaults sichern
    const cfg = {
      waiters:           Math.max(1, Math.min(50, +config.waiters || 5)),
      durationMin:       Math.max(0, +config.durationMin || 0),
      orderIntervalMin:  Math.max(1, +config.orderIntervalMin || 20),
      orderIntervalMax:  Math.max(2, +config.orderIntervalMax || 60),
      itemsMin:          Math.max(1, +config.itemsMin || 1),
      itemsMax:          Math.max(1, +config.itemsMax || 6),
      thekeMin:          Math.max(1, +config.thekeMin || 15),
      thekeMax:          Math.max(2, +config.thekeMax || 45),
      pickupMin:         Math.max(1, +config.pickupMin || 5),
      pickupMax:         Math.max(2, +config.pickupMax || 20),
      payFull:           Math.max(0, Math.min(100, +config.payFull ?? 60)),
      payPartial:        Math.max(0, Math.min(100, +config.payPartial ?? 30)),
      cancelRate:        Math.max(0, Math.min(50, +config.cancelRate ?? 5)),
      posRatio:          Math.max(0, Math.min(100, +config.posRatio ?? 0)),
    };

    this.products = this.db.prepare('SELECT id FROM products WHERE active=1').all().map(p=>p.id);
    this.tables   = this.db.prepare("SELECT id FROM tables WHERE name IS NULL OR name != 'POS'").all().map(t=>t.id);
    const posRow  = this.db.prepare("SELECT id FROM tables WHERE name='POS'").get();
    this.posTableId = posRow ? posRow.id : null;
    if(this.products.length === 0) throw new Error('Keine aktiven Produkte');
    if(this.tables.length   === 0) throw new Error('Keine Tische konfiguriert');

    this.state.config = cfg;
    this.state.startedAt = Date.now();
    this.state.stats = this.emptyStats();
    this.state.running = true;
    this.waiters = [];

    for(let i=1; i<=cfg.waiters; i++) this.spawnWaiter(`SIM_Bediener_${i}`);
    this.spawnTheke();
    this.spawnKasse();

    if(cfg.durationMin > 0){
      this.setTimer(() => this.stop(), cfg.durationMin * 60 * 1000);
    }

    this.log('info','simulator', `Start: ${cfg.waiters} Bediener, ${cfg.durationMin||'∞'} Min`);
  }

  stop(){
    if(!this.state.running) return;
    this.state.running = false;
    for(const id of this.timers) clearTimeout(id);
    this.timers.clear();
    this.waiters.forEach(w => { w.active = false; });
    this.log('info','simulator','Stop', { stats: this.state.stats });
  }

  cleanup(){
    const orders = this.db.prepare("SELECT id FROM orders WHERE waiter LIKE 'SIM_%'").all();
    const orderIds = orders.map(o => o.id);

    const tx = this.db.transaction(()=>{
      this.db.prepare("DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE waiter LIKE 'SIM_%')").run();
      this.db.prepare("DELETE FROM orders WHERE waiter LIKE 'SIM_%'").run();
      this.db.prepare("DELETE FROM waiter_sessions WHERE waiter LIKE 'SIM_%'").run();
    });
    tx();

    // Theken/Bediener-iPads sollen Listen neu laden
    for(const id of orderIds) this.broadcast('order:cancelled', { id });

    this.log('info','simulator', `Cleanup: ${orderIds.length} Orders entfernt`);
    return { ordersRemoved: orderIds.length };
  }

  // === Bediener-Loop: erzeugt regelmaessig Orders ===
  spawnWaiter(name){
    const w = { name, active: true, ordersCreated: 0 };
    this.waiters.push(w);
    try { this.db.prepare("INSERT OR REPLACE INTO waiter_sessions(waiter, last_heartbeat) VALUES(?, datetime('now'))").run(name); } catch(e){}

    const cfg = () => this.state.config;
    const loop = () => {
      if(!this.state.running || !w.active) return;

      try {
        const isPos    = cfg().posRatio > 0 && Math.random()*100 < cfg().posRatio;
        const tableId  = isPos ? this.posTableId : this.tables[Math.floor(Math.random()*this.tables.length)];
        if(!tableId)   throw new Error('Kein Tisch verfuegbar (POS evtl. nicht angelegt)');

        const count    = randomInt(cfg().itemsMin, cfg().itemsMax);
        const items    = [];
        const getPrice = this.db.prepare('SELECT price_cents FROM products WHERE id=?');
        for(let i=0;i<count;i++){
          const pid = this.products[Math.floor(Math.random()*this.products.length)];
          const r = getPrice.get(pid);
          if(r) items.push({ pid, price_cents: r.price_cents });
        }

        const waiterField = isPos ? 'SIM_POS' : name;
        let orderId;
        const tx = this.db.transaction(()=>{
          const info = this.db.prepare("INSERT INTO orders(table_id, waiter, status) VALUES(?, ?, 'open')").run(tableId, waiterField);
          orderId = info.lastInsertRowid;
          const ins = this.db.prepare('INSERT INTO order_items(order_id, product_id, ready, price_cents, batch) VALUES(?, ?, 0, ?, 1)');
          for(const it of items) ins.run(orderId, it.pid, it.price_cents);
        });
        tx();

        // POS-Orders sind sofort fertig+kassiert (kein Theken-Workflow noetig)
        if(isPos){
          this.db.prepare("UPDATE order_items SET ready=1, picked=1, paid=1 WHERE order_id=?").run(orderId);
          this.db.prepare("UPDATE orders SET status='paid' WHERE id=?").run(orderId);
          this.state.stats.itemsPaid += items.length;
          this.state.stats.ordersPaid++;
        }

        const newOrder = this.getOrderWithItems(orderId);
        if(newOrder) this.broadcast(isPos ? 'order:paid' : 'order:created', newOrder);

        this.state.stats.ordersCreated++;
        this.state.stats.itemsCreated += items.length;
        w.ordersCreated++;
      } catch(e){
        this.state.stats.errors++;
        this.log('warning','simulator', `Bediener ${name}: ${e.message}`);
      }

      const wait = randomInt(cfg().orderIntervalMin, cfg().orderIntervalMax) * 1000;
      this.setTimer(loop, wait);
    };
    this.setTimer(loop, Math.floor(Math.random()*5000));
  }

  // === Theke-Loop: markiert Items als ready, dann picked ===
  spawnTheke(){
    const cfg = () => this.state.config;
    const TICK_MS = 2000;

    const loop = () => {
      if(!this.state.running) return;
      try {
        // 1) Items, die noch nicht ready sind
        const items = this.db.prepare(`
          SELECT oi.id, oi.order_id
          FROM order_items oi
          JOIN orders o ON o.id = oi.order_id
          WHERE o.waiter LIKE 'SIM_%' AND oi.ready=0 AND oi.cancelled=0
        `).all();

        const touchedOrders = new Set();

        for(const item of items){
          // Storno-Chance
          if(Math.random()*100 < cfg().cancelRate * (TICK_MS/30000)){
            this.db.prepare('UPDATE order_items SET cancelled=1 WHERE id=?').run(item.id);
            this.state.stats.itemsCancelled++;
            touchedOrders.add(item.order_id);
            continue;
          }
          // Ready-Wahrscheinlichkeit: Tick/Wartezeit
          const targetSec = randomInt(cfg().thekeMin, cfg().thekeMax);
          const probPerTick = (TICK_MS/1000) / targetSec;
          if(Math.random() < probPerTick){
            this.db.prepare('UPDATE order_items SET ready=1 WHERE id=?').run(item.id);
            this.state.stats.itemsReady++;
            touchedOrders.add(item.order_id);
          }
        }

        // 2) Pickup: alle ready/cancelled & noch nicht alle picked
        const orders = this.db.prepare(`
          SELECT DISTINCT o.id FROM orders o
          JOIN order_items oi ON oi.order_id = o.id
          WHERE o.waiter LIKE 'SIM_%' AND o.status NOT IN ('paid','cancelled')
        `).all();

        for(const o of orders){
          const rows = this.db.prepare('SELECT ready, picked, cancelled FROM order_items WHERE order_id=? AND batch=1').all(o.id);
          if(rows.length === 0) continue;
          const allReady = rows.every(r => r.ready===1 || r.cancelled===1);
          const pendingPick = rows.some(r => r.picked===0 && r.cancelled===0);
          if(!allReady || !pendingPick) continue;
          const targetSec = randomInt(cfg().pickupMin, cfg().pickupMax);
          const probPerTick = (TICK_MS/1000) / targetSec;
          if(Math.random() < probPerTick){
            this.db.prepare('UPDATE order_items SET picked=1 WHERE order_id=? AND ready=1 AND cancelled=0').run(o.id);
            const picked = this.db.prepare('SELECT COUNT(*) as c FROM order_items WHERE order_id=? AND picked=1').get(o.id);
            this.state.stats.itemsPicked += picked.c;
            touchedOrders.add(o.id);
          }
        }

        for(const oid of touchedOrders){
          const ord = this.getOrderWithItems(oid);
          if(ord) this.broadcast('order:updated', ord);
        }
      } catch(e){
        this.state.stats.errors++;
        this.log('warning','simulator', `Theke: ${e.message}`);
      }
      this.setTimer(loop, TICK_MS);
    };
    this.setTimer(loop, 1000);
  }

  // === Kasse-Loop: voll/teil/offen-Mix ===
  spawnKasse(){
    const cfg = () => this.state.config;
    const TICK_MS = 5000;

    const loop = () => {
      if(!this.state.running) return;
      try {
        const orders = this.db.prepare(`
          SELECT id FROM orders
          WHERE waiter LIKE 'SIM_%' AND waiter != 'SIM_POS' AND status='open'
        `).all();

        for(const o of orders){
          const items = this.db.prepare('SELECT id, picked, paid, cancelled FROM order_items WHERE order_id=?').all(o.id);
          if(items.length === 0) continue;
          const allHandled = items.every(i => i.picked===1 || i.cancelled===1);
          if(!allHandled) continue;
          const unpaid = items.filter(i => i.paid===0 && i.cancelled===0);
          if(unpaid.length === 0) continue;

          const roll = Math.random()*100;
          if(roll < cfg().payFull){
            this.db.prepare('UPDATE order_items SET paid=1 WHERE order_id=? AND cancelled=0').run(o.id);
            this.db.prepare("UPDATE orders SET status='paid' WHERE id=?").run(o.id);
            this.state.stats.itemsPaid += unpaid.length;
            this.state.stats.ordersPaid++;
            this.broadcast('order:paid', { id: o.id });
          } else if(roll < cfg().payFull + cfg().payPartial){
            const halfCount = Math.max(1, Math.floor(unpaid.length/2));
            const toPay = unpaid.slice(0, halfCount);
            for(const it of toPay) this.db.prepare('UPDATE order_items SET paid=1 WHERE id=?').run(it.id);
            this.state.stats.itemsPaid += toPay.length;
            const after = this.db.prepare('SELECT paid, cancelled FROM order_items WHERE order_id=?').all(o.id);
            if(after.every(i => i.paid===1 || i.cancelled===1)){
              this.db.prepare("UPDATE orders SET status='paid' WHERE id=?").run(o.id);
              this.state.stats.ordersPaid++;
              this.broadcast('order:paid', { id: o.id });
            } else {
              const ord = this.getOrderWithItems(o.id);
              if(ord) this.broadcast('order:updated', ord);
            }
          }
          // sonst: offen lassen
        }
      } catch(e){
        this.state.stats.errors++;
        this.log('warning','simulator', `Kasse: ${e.message}`);
      }
      this.setTimer(loop, TICK_MS);
    };
    this.setTimer(loop, 3000);
  }
}
