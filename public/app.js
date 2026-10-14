// app.js (POS + Simulator + Multi-Theke + Kategorie-Nav)
const $  = (s)=>document.querySelector(s);
const $$ = (s)=>Array.from(document.querySelectorAll(s));
const on = (sel,evt,fn)=>{ const el=(typeof sel==='string')?$(sel):sel; if(el) el.addEventListener(evt,fn); };

const state={ role:'waiter', user:null, tables:[], products:[], orders:[], waiterHistory:[], posHistory:[], config:{}, version:(window.__APP_VERSION__||'dev'), posMode:false, posBasket:new Map(), sessions:[], heartbeatInterval:null, wakeLock:null, favorites:new Set(), favoritesFilterActive:false, selectedStation:null, selectedTheke:null, selectedCategory:null, ws:null, wsReconnectAttempts:0, connectionStatus:'offline', wsPingInterval:null, loginHealthCheckInterval:null, soundEnabled:localStorage.getItem('soundEnabled')!=='off', seenBatches:new Set(), thekeRendered:false };

// iOS PWA: Pinch-Zoom (Multi-Touch) komplett blocken (Safari Gesture Events)
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('gesturechange', (e) => e.preventDefault());
document.addEventListener('gestureend', (e) => e.preventDefault());

async function api(path, opts={}){ const res=await fetch(path,{ headers:{'Content-Type':'application/json'}, ...opts }); if(!res.ok){ let t=await res.text(); try{ const j=JSON.parse(t); t=j.error||j.message||t; }catch{}; throw new Error(t); } return res.json(); }

// =============================================================================
// UI-DIALOGE (Ersatz fuer alert/confirm)
// Native iOS-Apps zeigen keine Browser-Dialoge. Beide Funktionen rendern ein
// Bottom-Sheet und geben ein Promise zurueck, damit der Aufrufcode gleich
// bleibt: `await uiAlert(msg)` bzw. `if(!await uiConfirm(msg)) return;`
// =============================================================================

// Sheets stapeln sich nicht; ein offener Dialog wird vom naechsten ersetzt.
let _openSheet=null;

function closeSheet(result){
  if(!_openSheet) return;
  const {host, resolve}=_openSheet;
  _openSheet=null;
  host.classList.remove('sheet-open');
  // Erst nach der Ausfahr-Animation aus dem DOM nehmen
  setTimeout(()=>host.remove(), 260);
  resolve(result);
}

/* Baut ein Bottom-Sheet. buttons: [{label, value, variant}] - der letzte Eintrag
   ist die Primaeraktion (unten, hervorgehoben), wie in iOS-Action-Sheets. */
function openSheet({title, message, buttons, destructive=false}){
  if(_openSheet) closeSheet(null);

  const host=document.createElement('div');
  host.className='sheet-host';

  const backdrop=document.createElement('div');
  backdrop.className='sheet-backdrop';

  const sheet=document.createElement('div');
  sheet.className='sheet';
  sheet.setAttribute('role','alertdialog');
  sheet.setAttribute('aria-modal','true');

  const grabber=document.createElement('div');
  grabber.className='sheet-grabber';
  sheet.appendChild(grabber);

  const body=document.createElement('div');
  body.className='sheet-body';
  if(title){
    const h=document.createElement('div');
    h.className='sheet-title';
    h.textContent=title;
    body.appendChild(h);
  }
  if(message){
    const p=document.createElement('div');
    p.className='sheet-message';
    p.textContent=message;
    body.appendChild(p);
  }
  sheet.appendChild(body);

  const actions=document.createElement('div');
  actions.className='sheet-actions';
  buttons.forEach((b,i)=>{
    const btn=document.createElement('button');
    const isPrimary=i===buttons.length-1;
    btn.className='sheet-btn '+(b.variant || (isPrimary ? (destructive?'destructive':'primary') : 'cancel'));
    btn.textContent=b.label;
    btn.addEventListener('click',()=>closeSheet(b.value));
    actions.appendChild(btn);
  });
  sheet.appendChild(actions);

  host.append(backdrop,sheet);
  document.body.appendChild(host);

  // Tap auf den Hintergrund bricht ab, wie bei einem iOS-Sheet
  const cancelValue=buttons.find(b=>b.variant==='cancel')?.value ?? buttons[0]?.value ?? null;
  backdrop.addEventListener('click',()=>closeSheet(buttons.length>1?cancelValue:buttons[0]?.value));

  // Doppeltes rAF: erst nach dem Einfuegen animiert die Transition
  requestAnimationFrame(()=>requestAnimationFrame(()=>host.classList.add('sheet-open')));

  return new Promise(resolve=>{ _openSheet={host, resolve}; });
}

/* Ersatz fuer alert(): eine Schaltflaeche, Promise loest beim Schliessen. */
function uiAlert(message, {title=null}={}){
  return openSheet({ title, message, buttons:[{label:'OK', value:true, variant:'primary'}] });
}

/* Ersatz fuer confirm(): Promise<boolean>. destructive faerbt die Primaeraktion
   rot, wie iOS es bei Loeschen-Aktionen macht. */
function uiConfirm(message, {title=null, confirmLabel='OK', cancelLabel='Abbrechen', destructive=false}={}){
  return openSheet({
    title, message, destructive,
    buttons:[
      {label:cancelLabel, value:false, variant:'cancel'},
      {label:confirmLabel, value:true}
    ]
  });
}

// Escape schliesst das Sheet (Tastatur am iPad)
document.addEventListener('keydown',(e)=>{
  if(e.key==='Escape' && _openSheet) closeSheet(false);
});

// =============================================================================
// FARBSCHEMA
// Vorgabe ist die Systemeinstellung. Sobald der Nutzer den Schalter benutzt,
// gilt seine Wahl fest - an der Theke steht das iPad oft hell eingestellt in
// einem dunklen Raum, da hilft die Systemeinstellung allein nicht.
// =============================================================================
function storedTheme(){
  try{ return localStorage.getItem('theme'); }catch{ return null; }
}
function systemPrefersDark(){
  return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
}
function effectiveTheme(){
  return storedTheme() || (systemPrefersDark() ? 'dark' : 'light');
}
// Die Anmeldung ist immer hell, unabhaengig von gespeicherter Wahl und System.
// Das gewaehlte Schema greift erst nach dem Login; updateHeader ruft applyTheme
// erneut, sobald die Anmeldung betreten oder verlassen wird.
let _themeLoginLock=null;
function applyTheme(onLogin=currentViewId()==='#view-login'){
  _themeLoginLock=onLogin;
  const t=onLogin ? 'light' : storedTheme();
  // Ohne gespeicherte Wahl kein Attribut setzen, dann greift die Systemeinstellung
  if(t) document.documentElement.setAttribute('data-theme', t);
  else document.documentElement.removeAttribute('data-theme');
  const eff=onLogin ? 'light' : effectiveTheme();
  const icon=$('#btn-theme-toggle .material-symbols-outlined');
  if(icon) icon.textContent = eff==='dark' ? 'light_mode' : 'dark_mode';
  const lbl=$('#btn-theme-toggle .lbl');
  if(lbl) lbl.textContent = eff==='dark' ? 'Helles Design' : 'Dunkles Design';
  // Browser-Oberflaeche (Statusleiste der PWA) mitfaerben
  const meta=document.querySelector('meta[name="theme-color"]');
  if(meta) meta.setAttribute('content', eff==='dark' ? '#1c1c1e' : '#0a84ff');
}
// =============================================================================
// SCHRIFTGROESSE AN DER THEKE
// Wird als Faktor --tf gesetzt und von den Theken-Regeln in styles.css auf alle
// Schriftgroessen und die Kachelhoehen angewandt. Pro Geraet gespeichert, denn
// die 11- und die 12,9-Zoll-Theke brauchen unterschiedliche Stufen.
// =============================================================================
// Die Stationsansicht hat einen eigenen Wert mit 130 % als Vorgabe: dort steht
// man noch weiter weg, und die Kacheln sind gross genug fuer grosse Schrift.
const TF_MIN=0.75, TF_MAX=1.6, TF_STEP=0.05, TF_STATION_DEFAULT=1.3;

function inStationMode(){ return state.role==='bar' && state.selectedStation!==null; }
function fontScaleKey(){ return inStationMode() ? 'stationFontScale' : 'thekeFontScale'; }
function thekeFontScale(){
  const v=parseFloat(localStorage.getItem(fontScaleKey()));
  return (Number.isFinite(v) && v>=TF_MIN && v<=TF_MAX) ? v : (inStationMode() ? TF_STATION_DEFAULT : 1);
}
function applyThekeFontScale(){
  const v=thekeFontScale();
  document.documentElement.style.setProperty('--tf', String(v));
  const dec=$('#btn-font-dec'), inc=$('#btn-font-inc');
  // Auf Anschlag den Knopf sperren, damit sichtbar ist wo Schluss ist
  if(dec) dec.disabled = v<=TF_MIN+0.001;
  if(inc) inc.disabled = v>=TF_MAX-0.001;
}
function stepThekeFontScale(dir){
  const next=Math.min(TF_MAX, Math.max(TF_MIN, Math.round((thekeFontScale()+dir*TF_STEP)*100)/100));
  try{ localStorage.setItem(fontScaleKey(), String(next)); }catch{}
  applyThekeFontScale();
  showNotification(`Schriftgröße ${Math.round(next*100)} %`,'info');
  // Das POS-Gitter misst seine Kacheln selbst, nach der Aenderung neu rechnen
  if(typeof layoutPOSGrid==='function'){
    requestAnimationFrame(()=>{ layoutPOSGrid(); requestAnimationFrame(layoutPOSGrid); });
  }
}
applyThekeFontScale();

function toggleTheme(){
  const next = effectiveTheme()==='dark' ? 'light' : 'dark';
  try{ localStorage.setItem('theme', next); }catch{}
  applyTheme();
  showNotification(next==='dark'?'Dunkles Design':'Helles Design','info');
}
applyTheme();
// Systemwechsel nur uebernehmen, solange der Nutzer nicht selbst gewaehlt hat
if(window.matchMedia){
  window.matchMedia('(prefers-color-scheme: dark)')
    .addEventListener('change', ()=>{ if(!storedTheme()) applyTheme(); });
}

/* Tastatur-Hoehe als CSS-Variable bereitstellen.
   Sheets sitzen am unteren Rand und wuerden sonst von der Bildschirmtastatur
   verdeckt. Betrifft vor allem Rueckgeld-Rechner und Kommentar-Dialog. */
(function trackKeyboardInset(){
  const vv=window.visualViewport;
  if(!vv) return;
  const apply=()=>{
    const inset=Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    document.documentElement.style.setProperty('--kb-inset', Math.round(inset)+'px');
  };
  vv.addEventListener('resize', apply);
  vv.addEventListener('scroll', apply);
  apply();
})();

// =============================================================================
// LONG-PRESS (gemeinsamer Helper)
// Bricht bei Fingerbewegung ab, damit Scrollen ueber einer Kachel nicht nach
// 500ms den Long-Press ausloest. Setzt waehrend des Drucks eine Klasse fuer
// visuelles Feedback.
// =============================================================================
function bindLongPress(el, onLongPress, {onTap=null, delay=500, moveTolerance=10}={}){
  let timer=null, fired=false, startX=0, startY=0;

  // Ein Bedienelement innerhalb der Kachel (z.B. der Minus-Button) hat seine
  // eigene Aktion und darf den Long-Press nicht starten.
  const fromChildControl=(e)=>{
    const c=e.target.closest('button,a,input,select,textarea');
    return c && c!==el;
  };

  const clear=()=>{ if(timer){ clearTimeout(timer); timer=null; } el.classList.remove('pressing'); };
  const start=(x,y)=>{
    fired=false; startX=x; startY=y;
    clear();
    el.classList.add('pressing');
    timer=setTimeout(()=>{ fired=true; timer=null; el.classList.remove('pressing'); onLongPress(); }, delay);
  };
  const move=(x,y)=>{
    if(!timer) return;
    if(Math.abs(x-startX)>moveTolerance || Math.abs(y-startY)>moveTolerance) clear();
  };

  el.addEventListener('touchstart',(e)=>{ if(fromChildControl(e)) return; const t=e.touches[0]; start(t.clientX,t.clientY); },{passive:true});
  el.addEventListener('touchmove',(e)=>{ const t=e.touches[0]; move(t.clientX,t.clientY); },{passive:true});
  el.addEventListener('touchend',clear);
  el.addEventListener('touchcancel',clear);
  el.addEventListener('mousedown',(e)=>{ if(fromChildControl(e)) return; start(e.clientX,e.clientY); });
  el.addEventListener('mousemove',(e)=>move(e.clientX,e.clientY));
  el.addEventListener('mouseup',clear);
  el.addEventListener('mouseleave',clear);

  el.addEventListener('click',(e)=>{
    clear();
    // Klick kam vom Minus-Button: dessen Handler hat ihn schon behandelt
    if(fromChildControl(e)) return;
    if(fired){ fired=false; e.preventDefault(); e.stopPropagation(); return; }
    if(onTap) onTap(e);
  });
}

// =============================================================================
// WEBSOCKET CLIENT (Hybrid Mode with Polling Fallback)
// =============================================================================

function connectWebSocket() {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    console.log('[WebSocket] Already connected');
    return;
  }

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const host = window.location.host;
  const wsUrl = `${protocol}//${host}`;

  console.log('[WebSocket] Connecting to', wsUrl);

  try {
    state.ws = new WebSocket(wsUrl);

    state.ws.onopen = () => {
      console.log('✅ [WebSocket] Connected');

      // Ausstehende Disconnect-Meldung abbrechen (schnelle Reconnection = stille Wiederverbindung)
      if (state._disconnectNotifyTimeout) {
        clearTimeout(state._disconnectNotifyTimeout);
        state._disconnectNotifyTimeout = null;
      }

      // Reconnect-Meldung nur wenn vorher auch eine Disconnect-Meldung angezeigt wurde
      if (state._disconnectNotificationShown) {
        showNotification('Verbindung wiederhergestellt', 'success');
        state._disconnectNotificationShown = false;
      }

      state.wsReconnectAttempts = 0;
      state.connectionStatus = 'online';
      updateConnectionStatus();

      // HTTP Health-Check nicht mehr nötig, WS übernimmt
      stopLoginHealthCheck();

      // Send initial ping + client-info (viewport, role, UA)
      if (state.ws.readyState === WebSocket.OPEN) {
        state.ws.send(JSON.stringify({ event: 'ping', timestamp: new Date().toISOString() }));
        sendClientInfo();
      }

      // Start heartbeat (ping every 30 seconds)
      if (state.wsPingInterval) clearInterval(state.wsPingInterval);
      state.wsPingInterval = setInterval(() => {
        if (state.ws && state.ws.readyState === WebSocket.OPEN) {
          state.ws.send(JSON.stringify({ event: 'ping', timestamp: new Date().toISOString() }));
          console.log('[WebSocket] Ping sent');
        }
      }, 30000); // 30 seconds
    };

    state.ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        console.log('📩 [WebSocket] Received:', message.event, message.data);
        handleWebSocketEvent(message.event, message.data);
      } catch (err) {
        console.error('[WebSocket] Error parsing message:', err);
      }
    };

    state.ws.onclose = (event) => {
      console.log('❌ [WebSocket] Connection closed', event.code, event.reason);
      state.ws = null;
      state.connectionStatus = 'offline';
      updateConnectionStatus();

      // Stop heartbeat
      if (state.wsPingInterval) {
        clearInterval(state.wsPingInterval);
        state.wsPingInterval = null;
      }

      // Disconnect-Meldung erst nach 15 Sek. zeigen – kurzer Standby läuft still ab
      if (state._disconnectNotifyTimeout) clearTimeout(state._disconnectNotifyTimeout);
      state._disconnectNotificationShown = false;
      state._disconnectNotifyTimeout = setTimeout(() => {
        if (state.connectionStatus === 'offline') {
          showNotification('Verbindung unterbrochen', 'warning');
          state._disconnectNotificationShown = true;
        }
        state._disconnectNotifyTimeout = null;
      }, 15000);

      // Fallback: HTTP Health-Check während Reconnect-Versuchen
      startLoginHealthCheck();

      // Auto-reconnect: erster Versuch sofort (200ms), danach exponentieller Backoff
      state.wsReconnectAttempts++;
      const delay = state.wsReconnectAttempts === 1
        ? 200
        : Math.min(500 * Math.pow(2, state.wsReconnectAttempts - 1), 15000); // Max 15s
      console.log(`[WebSocket] Reconnecting in ${delay}ms (attempt ${state.wsReconnectAttempts})...`);

      setTimeout(() => {
        if (state.user) { // Only reconnect if still logged in
          connectWebSocket();
        }
      }, delay);
    };

    state.ws.onerror = (error) => {
      console.error('[WebSocket] Error:', error);
    };

  } catch (err) {
    console.error('[WebSocket] Failed to create connection:', err);
  }
}

function sendClientInfo() {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;
  try {
    const info = {
      viewport: { w: window.innerWidth, h: window.innerHeight },
      orientation: (window.innerWidth >= window.innerHeight) ? 'landscape' : 'portrait',
      dpr: window.devicePixelRatio || 1,
      standalone: window.matchMedia('(display-mode: standalone)').matches || !!window.navigator.standalone,
      userAgent: navigator.userAgent,
      role: state.role || null,
      user: state.user || null
    };
    state.ws.send(JSON.stringify({ event: 'client:info', data: info, timestamp: new Date().toISOString() }));
  } catch (err) {
    console.warn('[WebSocket] sendClientInfo failed:', err);
  }
}

// Erzwingt eine frische WS-Verbindung, auch wenn readyState faelschlich OPEN meldet
// (iOS-Standby-Zombie). Verwirft die alte Verbindung ohne deren Auto-Reconnect
// doppelt auszuloesen, und baut sofort neu auf -> frisches init mit aktuellem State.
function forceReconnectWebSocket() {
  if (state.ws) {
    const old = state.ws;
    state.ws = null;        // Guard in connectWebSocket umgehen + onclose entkoppeln
    old.onclose = null;     // kein zweiter Reconnect aus dem alten Socket
    old.onerror = null;
    old.onmessage = null;
    try { old.close(); } catch {}
  }
  if (state.wsPingInterval) { clearInterval(state.wsPingInterval); state.wsPingInterval = null; }
  connectWebSocket();
}

function disconnectWebSocket() {
  if (state.ws) {
    console.log('[WebSocket] Disconnecting...');
    state.ws.close(1000, 'User logout'); // 1000 = normal closure
    state.ws = null;
  }

  // Stop heartbeat
  if (state.wsPingInterval) {
    clearInterval(state.wsPingInterval);
    state.wsPingInterval = null;
  }

  state.wsReconnectAttempts = 0;
  state.connectionStatus = 'offline';
  updateConnectionStatus();
}

function updateConnectionStatus() {
  const statusIndicator = $('#connection-status');
  if (!statusIndicator) return;

  statusIndicator.className = 'connection-status ' + state.connectionStatus;
  statusIndicator.title = state.connectionStatus === 'online' ? 'Verbunden' : 'Keine Verbindung';
}

// HTTP Health-Check für Login-Seite (läuft bevor WS verbunden ist)
async function loginHealthCheck() {
  try {
    await fetch('/health');
    if (state.connectionStatus !== 'online') {
      state.connectionStatus = 'online';
      updateConnectionStatus();
    }
  } catch {
    if (state.connectionStatus !== 'offline') {
      state.connectionStatus = 'offline';
      updateConnectionStatus();
    }
  }
}

function startLoginHealthCheck() {
  loginHealthCheck(); // Sofortiger Check
  if (!state.loginHealthCheckInterval) {
    state.loginHealthCheckInterval = setInterval(loginHealthCheck, 5000);
  }
}

function stopLoginHealthCheck() {
  if (state.loginHealthCheckInterval) {
    clearInterval(state.loginHealthCheckInterval);
    state.loginHealthCheckInterval = null;
  }
}

function showNotification(message, type = 'info') {
  // Remove existing notification if any
  const existing = $('#notification-toast');
  if (existing) existing.remove();

  // Create notification element
  const notification = document.createElement('div');
  notification.id = 'notification-toast';
  notification.className = `notification-toast ${type}`;
  notification.textContent = message;

  document.body.appendChild(notification);

  // Show with animation
  setTimeout(() => notification.classList.add('show'), 10);

  // Auto-hide after 4 seconds
  setTimeout(() => {
    notification.classList.remove('show');
    setTimeout(() => notification.remove(), 300);
  }, 4000);
}

function handleWebSocketEvent(event, data) {
  switch (event) {
    case 'init':
      // Initial data when connecting
      console.log('[WebSocket] Received initial data');
      if (data.orders) state.orders = data.orders;
      if (data.sessions) state.sessions = data.sessions;
      if (data.products) state.products = data.products;
      renderActiveView();
      break;

    case 'order:created':
      // New order created
      console.log('[WebSocket] New order:', data.id);
      // Upsert statt blindem push: verhindert Duplikate, wenn parallel ein
      // state.orders-Reload (z.B. POS-Senden) dieselbe Order schon geladen hat.
      {
        const exIdx = state.orders.findIndex(o => o.id === data.id);
        if (exIdx !== -1) state.orders[exIdx] = data; else state.orders.push(data);
      }

      // Only re-render if relevant views are active
      if (!$('#view-theke').classList.contains('hidden')) {
        renderTheke();
      }
      if (!$('#view-tables').classList.contains('hidden')) {
        renderTables();
      }

      // Play notification sound (optional)
      playNotificationSound();
      maybeRefreshReport();
      maybeRefreshHistories();
      break;

    case 'order:updated':
      // Order updated (items ready, status changed)
      console.log('[WebSocket] Order updated:', data.id);
      const index = state.orders.findIndex(o => o.id === data.id);
      if (index !== -1) {
        state.orders[index] = data;
        renderActiveView();
      } else {
        // Order not in list yet (shouldn't happen, but handle it)
        state.orders.push(data);
        renderActiveView();
      }
      maybeRefreshReport();
      maybeRefreshHistories();
      break;

    case 'order:paid':
      // Order was paid
      console.log('[WebSocket] Order paid:', data.id);
      const paidOrder = state.orders.find(o => o.id === data.id);
      if (paidOrder && paidOrder.waiter === 'POS') {
        // POS-Order an der Theke bis "Abgeholt" sichtbar halten
        paidOrder.status = 'paid';
        paidOrder.items.forEach(it => { it.paid = true; });
      } else {
        state.orders = state.orders.filter(o => o.id !== data.id);
      }
      renderActiveView();
      maybeRefreshReport();
      maybeRefreshHistories();
      break;

    case 'session:update':
      // Waiter sessions updated
      console.log('[WebSocket] Sessions updated');
      state.sessions = data;
      updateHeader();

      // Re-render theke if active (shows waiter columns)
      if (!$('#view-theke').classList.contains('hidden')) {
        renderTheke();
      }
      break;

    case 'session:kicked':
      // Theke hat diesen Bediener abgemeldet
      if (state.role === 'waiter' && data.waiter === state.user) {
        console.log('[WebSocket] Wurde von der Theke abgemeldet');
        showNotification('Du wurdest von der Theke abgemeldet', 'warning');
        // Heartbeat stoppen damit Session nicht neu angelegt wird
        if (state.heartbeatInterval) {
          clearInterval(state.heartbeatInterval);
          state.heartbeatInterval = null;
        }
        // Nach kurzer Verzögerung (Meldung lesen) neu laden → Login-Seite
        setTimeout(() => {
          disconnectWebSocket();
          location.reload();
        }, 2500);
      }
      break;

    case 'order:items_added':
      // Nachträglich ergänzte Items - für die Theke wie eine neue Order (Sound + Toast)
      console.log('[WebSocket] Items added to order:', data.orderId, 'batch', data.batch);
      if (state.role === 'bar' && !$('#view-theke').classList.contains('hidden')) {
        playNotificationSound();
        const tableLbl = data.waiter==='POS' ? 'POS' : `Tisch ${tableDisplayNum(data.table_id)}`;
        const n = (data.items||[]).length;
        showNotification(`${tableLbl}: ${n} Produkt${n!==1?'e':''} ergänzt`, 'info');
      }
      // state.orders wurde bereits über order:updated aktualisiert (vom Server vorher gesendet)
      break;

    case 'order:cancelled':
      state.orders=state.orders.filter(o=>o.id!==data.id);
      if(!$('#view-tables').classList.contains('hidden')) renderTables();
      if(!$('#view-theke').classList.contains('hidden')) renderTheke();
      if(currentCashOrder && currentCashOrder.id===data.id){ currentCashOrder=null; renderTables(); show('#view-tables'); }
      maybeRefreshReport();
      maybeRefreshHistories();
      break;

    case 'products:updated':
      state.products = data;
      if (!$('#view-products').classList.contains('hidden')) renderProducts();
      break;

    case 'tables:updated':
      state.tables = data;
      if (!$('#view-tables').classList.contains('hidden')) renderTables();
      break;

    case 'config:updated':
      state.config = data;
      if (!$('#view-tables').classList.contains('hidden')) renderTables();
      break;

    case 'pong':
      // Pong response from server
      console.log('[WebSocket] Pong received');
      break;

    default:
      console.warn('[WebSocket] Unknown event:', event);
  }
}

// Helper: rendert eine bestimmte View aus dem aktuellen state (ohne show())
function renderForView(viewId){
  switch(viewId){
    case '#view-tables': renderTables(); break;
    case '#view-theke': renderTheke(); break;
    case '#view-cash-detail': if (currentCashOrder) renderCashDetail(); break;
    case '#view-products': renderProducts(); break;
    case '#view-pos-history': renderPOSHistory(); break;
    case '#view-orders-history': renderWaiterHistory(); break;
    // admin: tab-spezifisch, kein Auto-Render
  }
}

// Helper: rendert die aktuell sichtbare View neu (für WS-Events)
function renderActiveView() {
  if (!$('#view-tables').classList.contains('hidden')) renderTables();
  if (!$('#view-theke').classList.contains('hidden')) renderTheke();
  if (!$('#view-cash-detail').classList.contains('hidden') && currentCashOrder) renderCashDetail();
  if (!$('#view-products').classList.contains('hidden')) renderProducts();
  if (!$('#view-pos-history').classList.contains('hidden')) renderPOSHistory();
  if (!$('#view-orders-history').classList.contains('hidden')) renderWaiterHistory();
}
function maybeRefreshReport(){
  if(!$('#admin-report').classList.contains('hidden')) adminReportLoad();
}

// Reloadet die aktuell sichtbare(n) History-Views (Server-backed, nicht aus state.orders)
function maybeRefreshHistories(){
  if(!$('#view-pos-history').classList.contains('hidden')) loadPOSHistory();
  if(!$('#view-orders-history').classList.contains('hidden')) loadWaiterHistory();
}

// Helper: Play notification sound (optional)
function playNotificationSound() {
  if (!state.soundEnabled) return;
  // Only play if user is not on tables view (where they created the order)
  if ($('#view-theke') && !$('#view-theke').classList.contains('hidden')) {
    try {
      // Create simple beep using Web Audio API
      const audioContext = new (window.AudioContext || window.webkitAudioContext)();
      const oscillator = audioContext.createOscillator();
      const gainNode = audioContext.createGain();

      oscillator.connect(gainNode);
      gainNode.connect(audioContext.destination);

      oscillator.frequency.value = 800; // Frequency in Hz
      oscillator.type = 'sine';

      gainNode.gain.setValueAtTime(0.3, audioContext.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.2);

      oscillator.start(audioContext.currentTime);
      oscillator.stop(audioContext.currentTime + 0.2);
    } catch (err) {
      // Silently fail if audio not supported
      console.log('[Audio] Notification sound failed:', err.message);
    }
  }
}
function fmtEuro(v){ return v.toFixed(2).replace('.',',')+' €'; }
function toDate(s){ try{ if(!s) return new Date(); if(s.includes('T')) return new Date(s); return new Date(s.replace(' ','T')+'Z'); }catch{ return new Date(); } }
function fmtAgeMinutes(s){ const d=toDate(s); const m=Math.max(0,Math.floor((Date.now()-d.getTime())/60000)); return `${m} min`; }
/* Altersangaben auffrischen, ohne die Views neu zu bauen. Läuft über das
   data-created-at-Attribut statt über eine bestimmte View und deckt damit alle
   Theken-Render-Modi und den Kopf des Kassier-Details gleichermaßen ab. */
function refreshAges(){
  $$('[data-created-at]').forEach(el=>{
    const s=fmtAgeMinutes(el.dataset.createdAt);
    if(el.textContent!==s) el.textContent=s; // gleiche Minute -> kein Repaint
    // Dringlichkeitsstufe der Karte mitziehen, damit eine wartende Bestellung
    // sich von selbst meldet statt nur eine groessere Zahl zu zeigen.
    const card=el.closest('.order-card');
    if(card){
      const lvl=ageLevel(el.dataset.createdAt);
      if(card.dataset.ageLevel!==lvl) card.dataset.ageLevel=lvl;
    }
  });
}

/* Favorites Management */
function loadFavorites(){ if(!state.user) return; try{ const key=`favorites_${state.user}`; const data=localStorage.getItem(key); if(data){ const arr=JSON.parse(data); state.favorites=new Set(arr); } }catch{ state.favorites=new Set(); } }
function saveFavorites(){ if(!state.user) return; try{ const key=`favorites_${state.user}`; const arr=Array.from(state.favorites); localStorage.setItem(key,JSON.stringify(arr)); }catch{} }
function tableDisplayNum(tableId){ const list=state.tables.filter(t=>t.name!=='POS'); const idx=list.findIndex(t=>t.id===tableId); return idx>=0?idx+1:tableId; }
function toggleFavorite(tableId){ if(state.favorites.has(tableId)){ state.favorites.delete(tableId); } else { state.favorites.add(tableId); } saveFavorites(); }
function clearAllFavorites(){ state.favorites.clear(); saveFavorites(); }
function openFavoritesSettings(){ renderFavoritesSettings(); $('#fav-settings-modal').classList.remove('hidden'); }
function closeFavoritesSettings(){ $('#fav-settings-modal').classList.add('hidden'); }
function renderFavoritesSettings(){ const list=$('#fav-settings-list'); list.innerHTML=''; state.tables.forEach(t=>{ const item=document.createElement('div'); item.className='fav-setting-item'; const checkbox=document.createElement('input'); checkbox.type='checkbox'; checkbox.id=`fav-chk-${t.id}`; checkbox.checked=state.favorites.has(t.id); checkbox.addEventListener('change',()=>{ toggleFavorite(t.id); renderTables(); }); const label=document.createElement('label'); label.htmlFor=`fav-chk-${t.id}`; label.textContent=`Tisch ${tableDisplayNum(t.id)}`; item.append(checkbox,label); list.appendChild(item); }); }

/* Comment Dialog */
function openCommentDialog(productId){
  currentCommentProduct=state.products.find(p=>p.id===productId);
  if(!currentCommentProduct) return;
  $('#comment-product-name').textContent=currentCommentProduct.name;
  $('#comment-text').value='';
  $('#comment-modal').classList.remove('hidden');
}
function closeCommentDialog(){ $('#comment-modal').classList.add('hidden'); currentCommentProduct=null; }

/* Change Calculator Modal */
function openChangeModal(toPay, orderId=null, itemIds=null){
  $('#change-to-pay-input').value=toPay.toFixed(2).replace('.',',');
  $('#change-given-input').value='';
  $('#change-result-amount').textContent='0,00 €';
  $('#change-result-amount').style.color='#0a84ff';
  $('#change-modal').classList.remove('hidden');

  // Store the ORIGINAL amount (for database) and DISPLAY amount (for calculation)
  $('#change-modal').dataset.originalToPay=toPay.toFixed(2);
  $('#change-modal').dataset.toPay=toPay.toFixed(2);

  // Store order and item context for payment
  $('#change-modal').dataset.orderId=orderId||'';
  $('#change-modal').dataset.itemIds=itemIds?JSON.stringify(itemIds):'';

  setTimeout(()=>$('#change-given-input').focus(),100);
}
function closeChangeModal(){
  $('#change-modal').classList.add('hidden');
}
function saveComment(){
  if(!currentCommentProduct) return;
  // ID sichern: closeCommentDialog() setzt currentCommentProduct auf null
  const pid=currentCommentProduct.id;
  const comment=$('#comment-text').value.trim()||null;
  const basketItem=basket.get(pid);
  if(!basketItem){
    basket.set(pid,{items:[{comment}]});
  } else {
    basketItem.items.push({comment});
  }
  closeCommentDialog();
  if(!syncProductTile(pid)) renderProducts();
  updateSendButton();
}

/* Station Selection */
function openStationSelect(){ renderStationSelect(); $('#station-select-modal').classList.remove('hidden'); }
function closeStationSelect(){ $('#station-select-modal').classList.add('hidden'); }
function renderStationSelect(){
  const list=$('#station-select-list');
  list.innerHTML='';

  const theken=state.config.theken||[];
  const stations=state.config.stations||[];
  const productsWithStations=state.products.filter(p=>p.station);

  // Helper: ein anklickbares Auswahl-Item
  const makeItem=(title, sub, selected, onClick)=>{
    const item=document.createElement('div');
    item.className='station-select-item';
    item.style.cssText=`padding:16px;border:2px solid ${selected?'#0a84ff':'rgba(0,0,0,.1)'};border-radius:8px;margin-bottom:12px;cursor:pointer;background-color:${selected?'rgba(10,132,255,.05)':'transparent'}`;
    item.innerHTML=`<strong>${title}</strong>${sub?`<div class="muted">${sub}</div>`:''}`;
    item.addEventListener('click', onClick);
    return item;
  };
  const addHeader=(txt)=>{ const h=document.createElement('div'); h.className='muted small'; h.style.cssText='margin:0 0 8px;font-weight:700;letter-spacing:.5px'; h.textContent=txt; list.appendChild(h); };

  // Theke-Sektion (nur bei >=2 Theken). Theke-Klick aktualisiert nur die Markierung (Modal bleibt offen).
  if(theken.length>=2){
    addHeader('THEKE');
    theken.forEach(theke=>{
      const cnt=state.products.filter(p=>p.active && productInTheke(p.id, theke)).length;
      list.appendChild(makeItem(theke, `${cnt} Produkte`, state.selectedTheke===theke, ()=>{
        state.selectedTheke=theke;
        renderStationSelect();
        renderTheke();
        updateHeader('#view-theke');
      }));
    });
  }

  // Station-Sektion (nur wenn Produkte einer Station zugeordnet sind). Station-Klick schließt das Modal.
  if(productsWithStations.length>0){
    if(theken.length>=2){ const sep=document.createElement('div'); sep.style.cssText='height:1px;background:rgba(0,0,0,.1);margin:4px 0 16px'; list.appendChild(sep); }
    addHeader('STATION');
    list.appendChild(makeItem('Alle Bestellungen','Normale Thekenansicht', state.selectedStation===null, ()=>{
      state.selectedStation=null; closeStationSelect(); renderTheke(); updateHeader('#view-theke');
    }));
    stations.forEach(station=>{
      if(!state.products.some(p=>p.station===station)) return;
      const cnt=state.products.filter(p=>p.station===station).length;
      list.appendChild(makeItem(station, `${cnt} Produkt${cnt!==1?'e':''}`, state.selectedStation===station, ()=>{
        state.selectedStation=station; closeStationSelect(); renderTheke(); updateHeader('#view-theke');
      }));
    });
  }

  if(theken.length<2 && productsWithStations.length===0){
    list.innerHTML='<div class="muted text-center">Keine Theken oder Stationen konfiguriert.</div>';
  }
}

/* Waiter Overview */
function openWaiterOverview(){ renderWaiterOverview(); $('#waiter-overview-modal').classList.remove('hidden'); }
function closeWaiterOverview(){ $('#waiter-overview-modal').classList.add('hidden'); }
async function renderWaiterOverview(){
  const list=$('#waiter-overview-list');
  list.innerHTML='';
  const waiters=state.sessions.filter(s=>s.waiter!=='Theke' && s.waiter!=='Admin' && s.waiter!=='POS');
  if(waiters.length===0){
    list.innerHTML='<div class="muted text-center">Keine Bediener angemeldet</div>';
    return;
  }
  waiters.forEach(w=>{
    const item=document.createElement('div');
    item.className='waiter-item';
    const nameDiv=document.createElement('div');
    nameDiv.className='waiter-name';
    nameDiv.innerHTML=`<strong>${w.waiter}</strong>`;
    const timeDiv=document.createElement('div');
    timeDiv.className='waiter-time muted';
    const lastSeen=toDate(w.last_heartbeat);
    const diff=Math.floor((Date.now()-lastSeen.getTime())/1000);
    timeDiv.textContent=diff<120?'aktiv':`vor ${Math.floor(diff/60)} min`;
    const logoutBtn=document.createElement('button');
    logoutBtn.className='outline';
    logoutBtn.innerHTML='<span class="material-symbols-outlined">logout</span> Abmelden';
    logoutBtn.addEventListener('click', async ()=>{
      if(!await uiConfirm(`${w.waiter} wird abgemeldet und muss sich neu anmelden.`,{title:`${w.waiter} abmelden?`,confirmLabel:'Abmelden',destructive:true})) return;
      try{
        await api(`/api/sessions/${encodeURIComponent(w.waiter)}`, {method:'DELETE'});
        state.sessions=await api('/api/sessions');
        renderWaiterOverview();
        renderTheke();
      }catch(e){
        uiAlert(e.message,{title:'Abmelden fehlgeschlagen'});
      }
    });
    const leftDiv=document.createElement('div');
    leftDiv.append(nameDiv,timeDiv);
    item.append(leftDiv,logoutBtn);
    list.appendChild(item);
  });
}

/* Welche View gerade sichtbar ist. Wird gebraucht, wenn updateHeader() ohne
   Argument gerufen wird, etwa aus dem session:update-Ereignis. */
function currentViewId(){
  const v=$$('.view').find(x=>!x.classList.contains('hidden'));
  return v ? '#'+v.id : '#view-login';
}

function updateHeader(viewId){
  // Ohne Argument sonst: Titel faellt auf "Bestellsystem" zurueck und alle
  // view-abhaengigen Knoepfe verschwinden, bis das naechste Rendern laeuft.
  if(!viewId) viewId=currentViewId();
  const titles={'#view-login':'Login','#view-tables':'Tische','#view-products':'Produkte','#view-theke':'Theke','#view-cash':'Kassieren','#view-cash-detail':'Bestellung','#view-admin':'Admin','#view-pos-history':'Letzte Bestellungen','#view-orders-history':'Meine Bestellungen'};
  let title=titles[viewId]||'Bestellsystem';
  if(viewId==='#view-theke'){
    if(state.selectedTheke && state.selectedStation) title=`${state.selectedTheke} · ${state.selectedStation}`;
    else if(state.selectedTheke) title=state.selectedTheke;
    else if(state.selectedStation) title=`Station: ${state.selectedStation}`;
  }
  $('#hdr-title').textContent=title;
  const onLogin=viewId==='#view-login';
  if(onLogin!==_themeLoginLock) applyTheme(onLogin);
  const isTablesView=viewId==='#view-tables';
  const isThekeView=viewId==='#view-theke';

  // Prüfen ob es Produkte mit Stationen gibt
  const hasStationProducts=state.products.some(p=>p.station);

  $('#btn-logout').classList.toggle('hidden', onLogin || viewId==='#view-products' || viewId==='#view-pos-history' || viewId==='#view-orders-history' || viewId==='#view-cash-detail');
  $('#btn-back-header').classList.toggle('hidden', !(viewId==='#view-products' || viewId==='#view-pos-history' || viewId==='#view-orders-history' || viewId==='#view-cash-detail'));
  $('#btn-send-header').classList.toggle('hidden', viewId!=='#view-products');
  $('#btn-pos-toggle').classList.toggle('hidden', viewId!=='#view-theke' || state.role!=='bar' || state.selectedStation!==null);
  $('#btn-pos-history').classList.toggle('hidden', !(viewId==='#view-theke' && state.role==='bar' && state.selectedStation===null));
  const hasMultiTheke=(state.config.theken||[]).length>=2;
  $('#btn-station-select').classList.toggle('hidden', !(state.role==='bar' && isThekeView && (hasStationProducts || hasMultiTheke)));
  $('#btn-station-select').classList.toggle('active', state.selectedStation!==null);
  $('#btn-sound-toggle').classList.toggle('hidden', !(state.role==='bar' && isThekeView));
  // Schriftregler nur an der Theke, dort sitzt der Nutzer weit weg vom Display
  $('#theke-font-stepper').classList.toggle('hidden', !(state.role==='bar' && isThekeView));
  // Design-Schalter ueberall ausser auf der Anmeldung
  // Design-Schalter nur dort, wo er nicht im Weg ist: beim Bediener auf der
  // Tischuebersicht, nicht in der Produktauswahl. Theke und Admin behalten ihn,
  // sonst gaebe es an der Theke keinen Zugang zum dunklen Schema.
  const themeVisible = (state.role==='waiter') ? isTablesView : !onLogin;
  $('#btn-theme-toggle').classList.toggle('hidden', !themeVisible);
  $('#btn-sound-toggle .material-symbols-outlined').textContent=state.soundEnabled?'volume_up':'volume_off';
  $('#hdr-right').classList.toggle('hidden', viewId!=='#view-cash-detail');
  $('#btn-fav-filter').classList.toggle('hidden', !(state.role==='waiter' && isTablesView));
  $('#btn-orders-history').classList.toggle('hidden', !(state.role==='waiter' && isTablesView));
  const filterIcon=$('#btn-fav-filter .material-symbols-outlined');
  if(filterIcon){ filterIcon.textContent=state.favoritesFilterActive?'star':'star_outline'; }
  $('#btn-fav-filter').classList.toggle('active', state.favoritesFilterActive);
  $('#btn-waiter-overview').classList.toggle('hidden', !(state.role==='bar' && viewId==='#view-theke' && state.selectedStation===null));

  // Update waiter count badge
  const waiterBtn=$('#btn-waiter-overview');
  let waiterBadge=waiterBtn.querySelector('.btn-badge');
  if(!waiterBadge){
    waiterBadge=document.createElement('span');
    waiterBadge.className='btn-badge';
    waiterBtn.appendChild(waiterBadge);
  }
  const waiterCount=state.sessions.filter(s=>s.waiter!=='Theke' && s.waiter!=='Admin' && s.waiter!=='POS').length;
  waiterBadge.textContent=waiterCount;
  waiterBadge.style.display=waiterCount>0?'':'none';

  if(viewId==='#view-products'){ $('#hdr-left').textContent=''; }
  else if(state.role==='bar') $('#hdr-left').textContent='v'+state.version;
  else if(state.role==='waiter') $('#hdr-left').textContent=state.user||'';
  else if(state.role==='admin') $('#hdr-left').textContent='v'+state.version;
  else $('#hdr-left').textContent='';

  $('#btn-sound-toggle .lbl').textContent=state.soundEnabled?'Ton ausschalten':'Ton einschalten';

  syncHeaderMenu(state.role==='bar' && isThekeView && state.selectedStation!==null);
  // Station und normale Theke haben getrennte Schriftgroessen
  applyThekeFontScale();

  // Update connection status indicator
  updateConnectionStatus();
}

// =============================================================================
// HEADER-MENUE (Hamburger), nur in der Stationsansicht der Theke
// Die Knoepfe werden umgehaengt statt dupliziert, behalten also IDs, Handler
// und die Sichtbarkeitsregeln aus updateHeader. Ausserhalb der Station stehen
// sie wieder an ihrem alten Platz. Antippen eines Eintrags schliesst das Menue,
// der Schriftregler nicht, damit man mehrere Stufen hintereinander tippen kann.
// =============================================================================
// Reihenfolge im Menue; Abmelden zuletzt
const HDR_MENU_IDS=['#btn-station-select','#btn-sound-toggle','#btn-theme-toggle','#theke-font-stepper','#btn-logout'];
// Urspruengliche Reihenfolge rechts im Header (alle direkt vor dem Senden-Knopf)
const HDR_RIGHT_IDS=['#btn-sound-toggle','#btn-theme-toggle','#theke-font-stepper','#btn-station-select'];
function syncHeaderMenu(menuMode){
  const header=$('#app-header');
  if(header.classList.contains('menu-mode')!==menuMode){
    header.classList.toggle('menu-mode', menuMode);
    if(menuMode){
      const menu=$('#hdr-menu');
      HDR_MENU_IDS.forEach(id=>menu.appendChild($(id)));
    } else {
      closeHeaderMenu();
      const send=$('#btn-send-header');
      HDR_RIGHT_IDS.forEach(id=>send.before($(id)));
      $('#app-header .left').prepend($('#btn-logout'));
    }
  }
  const hasItems=menuMode && $$('#hdr-menu > *').some(el=>!el.classList.contains('hidden'));
  $('#btn-menu').classList.toggle('hidden', !hasItems);
  if(!hasItems) closeHeaderMenu();
}
function openHeaderMenu(){
  $('#hdr-menu').classList.remove('hidden');
  $('#btn-menu').classList.add('active');
  $('#btn-menu').setAttribute('aria-expanded','true');
}
function closeHeaderMenu(){
  $('#hdr-menu').classList.add('hidden');
  $('#btn-menu').classList.remove('active');
  $('#btn-menu').setAttribute('aria-expanded','false');
}
function show(viewId){
  $$('.view').forEach(v=>v.classList.add('hidden'));
  $(viewId).classList.remove('hidden');
  $('#app-header').classList.remove('hidden');
  updateHeader(viewId);

  // 🔒 iOS PWA: Scroll-Lock für Theke aktivieren
  const isTheke = (viewId === '#view-theke');
  document.body.classList.toggle('lock-scroll', isTheke);

  if (isTheke) {
    window.scrollTo(0, 0);
    // iOS-Scroll-Fixes anwenden
    requestAnimationFrame(() => applyThekeScrollFixes());
  }

  // Aktuellen state in die sichtbare View rendern (gegen veralteten DOM nach View-Wechsel)
  renderForView(viewId);
}
function setRole(r){ state.role=r; $$('.role-switch .role').forEach(b=>b.classList.toggle('active', b.dataset.role===r)); const isWaiter=r==='waiter'; $('#name-wrap').classList.toggle('hidden', !isWaiter); $('#pin-wrap').classList.toggle('hidden', isWaiter); }
$$('.role-switch .role').forEach(b=>on(b,'click',()=>setRole(b.dataset.role))); setRole('waiter');

on('#btn-login','click', async ()=>{
  try{
    if(state.role==='waiter'){
      const name=$('#inp-name').value.trim();
      if(!name) return uiAlert('Bitte gib deinen Namen ein.',{title:'Name fehlt'});
      // Namen beim Server belegen - er lehnt ab, wenn schon jemand so angemeldet ist
      try{
        await api('/api/sessions/login',{method:'POST', body:JSON.stringify({waiter:name})});
      }catch(e){
        return uiAlert(e.message,{title:'Anmeldung nicht möglich'});
      }
      state.user=name;
      try{
        await loadInitial();
        loadFavorites();
        await startHeartbeat();
        await requestWakeLock();

        // 🚀 Connect WebSocket (Health-Check läuft weiter bis WS-onopen stopLoginHealthCheck aufruft)
        connectWebSocket();

        renderTables();
        show('#view-tables');
        pollOrders(); // Fallback polling (30s)
      }catch(e){
        // Anmeldung abgebrochen: Namen wieder freigeben, sonst sperrt sich der
        // Bediener beim naechsten Versuch mit seiner eigenen Leiche aus.
        try{ await api(`/api/sessions/${encodeURIComponent(name)}`,{method:'DELETE'}); }catch{}
        state.user=null;
        throw e;
      }
    }
    else if(state.role==='bar'){
      const pin=$('#inp-pin').value.trim();
      if(!pin||pin.length<4) return uiAlert('Die PIN besteht aus mindestens vier Ziffern.',{title:'PIN unvollständig'});

      // Validate PIN against server
      const authResult = await api('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ role: 'bar', pin })
      });

      if(!authResult.success) return uiAlert('Diese PIN ist nicht gültig. Bitte versuche es erneut.',{title:'Anmeldung fehlgeschlagen'});

      state.user='Theke';
      await loadInitial();
      await requestWakeLock();

      // Theke-Auswahl: 1 Theke = automatisch, >=2 = erste als Default + Auswahl-Modal, 0 = alle (null)
      const theken=state.config.theken||[];
      state.selectedTheke = theken.length>=1 ? theken[0] : null;

      // 🚀 Connect WebSocket (Health-Check läuft weiter bis WS-onopen stopLoginHealthCheck aufruft)
      connectWebSocket();

      renderTheke();
      show('#view-theke');
      if(theken.length>=2) openStationSelect(); // zur Theke-Wahl auffordern
      pollOrders(); // Fallback polling (30s)
    }
    else {
      const pin=$('#inp-pin').value.trim();
      if(!pin||pin.length<4) return uiAlert('Die PIN besteht aus mindestens vier Ziffern.',{title:'PIN unvollständig'});

      // Validate PIN against server
      const authResult = await api('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ role: 'admin', pin })
      });

      if(!authResult.success) return uiAlert('Diese PIN ist nicht gültig. Bitte versuche es erneut.',{title:'Anmeldung fehlgeschlagen'});

      state.user='Admin';
      await loadInitial();
      await requestWakeLock();

      // 🚀 Connect WebSocket
      connectWebSocket();

      await adminInit();
      show('#view-admin');
      pollOrders(); // Fallback polling (30s)
    }
  }catch(e){
    uiAlert(e.message,{title:'Fehler'});
  }
});
on('#btn-logout','click', async ()=>{
  if(!await uiConfirm('Du wirst abgemeldet und landest wieder auf der Anmeldung.',{title:'Abmelden?',confirmLabel:'Abmelden',destructive:true})) return;
  releaseWakeLock();
  await stopHeartbeat();

  // 🚀 Disconnect WebSocket
  disconnectWebSocket();

  // Zurück zur Login-Seite: Health-Check neu starten für Verbindungsanzeige
  startLoginHealthCheck();

  location.reload();
});
on('#btn-back-header','click', ()=>{
  const currentView=$$('.view').find(v=>!v.classList.contains('hidden'));
  if(currentView && currentView.id==='view-products' && addToOrderId){ addToOrderId=null; basket.clear(); openCashDetail(currentCashOrder.id); return; }
  if(currentView && currentView.id==='view-pos-history') show('#view-theke');
  else if(currentView && currentView.id==='view-orders-history') show('#view-tables');
  else if(currentView && currentView.id==='view-cash-detail'){ renderTables(); show('#view-tables'); }
  else show('#view-tables');
});
on('#btn-send-header','click', ()=>sendOrder());
on('#btn-pos-toggle','click', ()=>{ state.posMode=!state.posMode; state.selectedCategory=null; $('#btn-pos-toggle').textContent=state.posMode?'POS: AN':'POS: AUS'; $('#btn-pos-toggle').classList.toggle('active', state.posMode); renderTheke(); updateHeader('#view-theke'); });
on('#btn-theme-toggle','click', ()=>toggleTheme());
on('#btn-menu','click', (e)=>{
  e.stopPropagation();
  if($('#hdr-menu').classList.contains('hidden')) openHeaderMenu(); else closeHeaderMenu();
});
// In der Capture-Phase, weil der Long-Press des Favoriten-Knopfs den Klick
// stoppt; der eigentliche Handler des Eintrags laeuft danach trotzdem.
$('#hdr-menu').addEventListener('click', (e)=>{
  const btn=e.target.closest('button');
  if(btn && !btn.closest('.font-stepper')) closeHeaderMenu();
}, true);
// Tipp ausserhalb schliesst das Menue
document.addEventListener('click', (e)=>{
  if(!e.target.closest('#hdr-menu') && !e.target.closest('#btn-menu')) closeHeaderMenu();
});
on('#btn-font-dec','click', ()=>stepThekeFontScale(-1));
on('#btn-font-inc','click', ()=>stepThekeFontScale(+1));
on('#btn-sound-toggle','click', ()=>{ state.soundEnabled=!state.soundEnabled; localStorage.setItem('soundEnabled',state.soundEnabled?'on':'off'); updateHeader('#view-theke'); });
on('#btn-pos-history','click', ()=>openPOSHistory());
on('#btn-orders-history','click', ()=>openWaiterHistory());
// Stern-Button: Tap = Filter toggle · Long-Press (500ms) = Verwalten-Modal
(function bindFavBtnLongPress(){
  const btn=$('#btn-fav-filter');
  if(!btn) return;
  bindLongPress(btn, ()=>openFavoritesSettings(), {onTap:()=>{
    state.favoritesFilterActive=!state.favoritesFilterActive;
    renderTables();
    updateHeader('#view-tables');
  }});
})();
on('#btn-close-fav-modal','click', ()=>closeFavoritesSettings());
on('#btn-close-fav-modal-footer','click', ()=>closeFavoritesSettings());
on('#btn-show-thresholds','click', ()=>$('#thresholds-modal').classList.remove('hidden'));
on('#btn-close-thresholds','click', ()=>$('#thresholds-modal').classList.add('hidden'));
on('#btn-close-thresholds-footer','click', ()=>$('#thresholds-modal').classList.add('hidden'));
on('#btn-clear-all-fav','click', async ()=>{ if(await uiConfirm('Alle markierten Tische werden aus den Favoriten entfernt.',{title:'Favoriten leeren?',confirmLabel:'Entfernen',destructive:true})){ clearAllFavorites(); renderFavoritesSettings(); renderTables(); } });
on('#btn-close-comment-modal','click', ()=>closeCommentDialog());
on('#btn-cancel-comment','click', ()=>closeCommentDialog());
on('#btn-save-comment','click', ()=>saveComment());
on('#btn-close-change-modal','click', ()=>closeChangeModal());
on('#btn-cancel-change','click', ()=>closeChangeModal());
on('#btn-confirm-change','click', async ()=>{
  const modal=$('#change-modal');
  const orderId=modal.dataset.orderId;
  const itemIdsJson=modal.dataset.itemIds;

  try{
    // Check if we have order context from modal
    if(orderId && orderId!==''){
      const itemIds=itemIdsJson?JSON.parse(itemIdsJson):null;

      if(itemIds && itemIds.length>0){
        // Partial payment: pay specific items
        await api(`/api/orders/${orderId}/pay-items`,{method:'POST', body:JSON.stringify({itemIds})});
      } else {
        // Full payment: pay entire order
        await api(`/api/orders/${orderId}/pay`,{method:'POST'});
      }

      state.orders=await api('/api/orders');

      // Update cash detail view if we're in it
      if(currentCashOrder && currentCashOrder.id==orderId){
        const wasInCashDetail = !$('#view-cash-detail').classList.contains('hidden');
        currentCashOrder=state.orders.find(o=>o.id==orderId);
        if(!currentCashOrder || currentCashOrder.status==='paid'){
          // Order vollständig bezahlt → direkt zur Tisch-Übersicht
          renderTables();
          show('#view-tables');
        } else if(wasInCashDetail) {
          // Noch unbezahlte Items, im Detail bleiben
          selectedItems.clear();
          renderCashDetail();
        }
      } else {
        // Nicht im Kassier-Detail, Theke aktualisieren
        renderTheke();
      }
    } else {
      // No order context - check if POS basket has items
      if(state.posBasket && state.posBasket.size > 0){
        // Create and pay POS order (same as "Alles kassiert")
        const items=[];
        state.posBasket.forEach((q,pid)=>{ for(let i=0;i<q;i++) items.push(pid); });
        const posTable=state.tables.find(t=>t.name==='POS');
        const table=posTable?.id||(state.tables[0]?.id||1);
        const orderRes=await api('/api/orders',{method:'POST', body:JSON.stringify({ table_id: table, waiter: 'POS', items, theke: state.selectedTheke })});
        await api(`/api/orders/${orderRes.id}/pay`,{method:'POST'});
        state.posBasket.clear();
        state.orders=await api('/api/orders');
        renderTheke();
      } else {
        // No order context and no basket, just refresh theke
        renderTheke();
      }
    }

    // Handle POS-specific cleanup
    if(state.currentPOSOrderId){
      state.currentPOSOrderId=null;
      state.posBasket.clear();
      renderTheke();
    }
  }catch(err){
    console.error('Failed to mark order/items as paid:',err);
  }

  closeChangeModal();
});

// Change modal: Calculate change
function calculateChangeInModal(){
  // Use the editable "Zu kassieren" field for calculation
  const toPayInput=$('#change-to-pay-input').value.trim().replace(',','.');
  const toPay=parseFloat(toPayInput)||0;
  const givenInput=$('#change-given-input').value.trim().replace(',','.');
  const given=parseFloat(givenInput)||0;
  const change=Math.max(0,given-toPay);

  const resultEl=$('#change-result-amount');
  resultEl.textContent=fmtEuro(change);

  // Color coding
  if(given<toPay && given>0){
    resultEl.style.color='red';
  } else if(change===0 && given>0){
    resultEl.style.color='green';
  } else {
    resultEl.style.color='#0a84ff';
  }
}

on('#change-to-pay-input','input',calculateChangeInModal);
on('#change-given-input','input',calculateChangeInModal);

// Auto-clear "Zu kassieren" field on focus
on('#change-to-pay-input','focus',(e)=>{
  e.target.select(); // Select all text so it gets replaced on typing
});

// Quick buttons - ADD to current value
document.addEventListener('click',(e)=>{
  const btn=e.target.closest('.change-quick-btn');
  if(!btn) return;

  const addValue=parseFloat(btn.dataset.value)||0;
  const currentInput=$('#change-given-input').value.trim().replace(',','.');
  const currentValue=parseFloat(currentInput)||0;
  const newValue=currentValue+addValue;
  $('#change-given-input').value=newValue.toFixed(2).replace('.',',');
  calculateChangeInModal();
});

// Reset button
on('#btn-reset-change-input','click',()=>{
  $('#change-given-input').value='';
  calculateChangeInModal();
});
on('#btn-waiter-overview','click', ()=>openWaiterOverview());
on('#btn-close-waiter-modal','click', ()=>closeWaiterOverview());
on('#btn-close-waiter-modal-footer','click', ()=>closeWaiterOverview());
on('#btn-station-select','click', ()=>openStationSelect());
on('#btn-close-station-modal','click', ()=>closeStationSelect());
on('#btn-close-station-modal-footer','click', ()=>closeStationSelect());

async function loadInitial(){ state.config=await api('/api/config'); state.tables=await api('/api/tables'); state.products=await api('/api/products'); state.orders=await api('/api/orders'); state.sessions=await api('/api/sessions'); }

async function requestWakeLock(){
  try{
    if('wakeLock' in navigator){
      state.wakeLock=await navigator.wakeLock.request('screen');
      console.log('Wake Lock aktiv - Display bleibt eingeschaltet');
      state.wakeLock.addEventListener('release',()=>{ console.log('Wake Lock freigegeben'); });
    }
  }catch(err){ console.log('Wake Lock nicht verfügbar:',err.message); }
}

function releaseWakeLock(){
  if(state.wakeLock){
    state.wakeLock.release();
    state.wakeLock=null;
  }
}

async function startHeartbeat(){
  if(state.role==='waiter' && state.user){
    await api('/api/sessions/heartbeat', {method:'POST', body:JSON.stringify({waiter:state.user})});
    // Sofort lokal eintragen, damit die Anzeige nicht auf das WS-init-Event warten muss
    if(!state.sessions.find(s=>s.waiter===state.user)){
      state.sessions.push({ waiter:state.user, last_heartbeat:new Date().toISOString() });
    }
    if(state.heartbeatInterval) clearInterval(state.heartbeatInterval);
    state.heartbeatInterval=setInterval(async ()=>{
      try{ await api('/api/sessions/heartbeat', {method:'POST', body:JSON.stringify({waiter:state.user})}); }catch{}
    }, 60000); // Every 60 seconds
  }
}

async function stopHeartbeat(){
  if(state.heartbeatInterval){
    clearInterval(state.heartbeatInterval);
    state.heartbeatInterval=null;
  }
  if(state.role==='waiter' && state.user){
    try{ await api(`/api/sessions/${encodeURIComponent(state.user)}`, {method:'DELETE'}); }catch{}
  }
}

/* Waiter */
function renderTables(){
  const grid=$('#tables-grid');
  grid.innerHTML='';
  const cols=Math.max(3,Math.min(6,+(state.config.grid_cols??4)));
  grid.style.setProperty('--cols',cols);
  const by={};
  state.orders.filter(o=>o.status!=='paid'&&o.waiter===state.user).forEach(o=>{by[o.table_id]=(by[o.table_id]||0)+1});

  let tablesToShow=state.tables.filter(t=>t.name!=='POS');
  if(state.favoritesFilterActive){
    tablesToShow=tablesToShow.filter(t=>state.favorites.has(t.id));
  }

  tablesToShow.forEach(t=>{
    const b=document.createElement('button');
    b.className='table-btn';
    b.dataset.tableId=t.id;

    const num=document.createElement('span');
    num.textContent=tableDisplayNum(t.id);
    b.appendChild(num);

    if(state.favorites.has(t.id)){
      const star=document.createElement('span');
      star.className='fav-star material-symbols-outlined';
      star.textContent='star';
      b.appendChild(star);
    }

    if(by[t.id]){
      const d=document.createElement('span');
      d.className='dot';
      b.appendChild(d);
    }

    bindLongPress(b, ()=>toggleFavoriteFromPress(t.id), {onTap:()=>{
      // Smart-Click: aktive Bestellung auf dem Tisch → Kassier-Detail; sonst Produkt-Grid.
      // Mehrere offene Bestellungen desselben Bedieners auf einem Tisch kann die
      // Oberfläche nicht erzeugen; träte es doch auf, wird die älteste geöffnet.
      if(by[t.id]){
        const myOrders=state.orders.filter(o =>
          o.table_id===t.id &&
          o.waiter===state.user &&
          o.status!=='paid' &&
          o.status!=='cancelled'
        );
        if(myOrders.length>0){
          openCashDetail(myOrders[0].id);
          return;
        }
      }
      openProducts(t.id);
    }});

    grid.appendChild(b);
  });
}

/* Long-Press auf einen Tisch schaltet den Favoriten um. Toast statt stiller
   Aenderung, damit die Geste nachvollziehbar bleibt. */
function toggleFavoriteFromPress(tableId){
  toggleFavorite(tableId);
  const isFav=state.favorites.has(tableId);
  showNotification(`Tisch ${tableDisplayNum(tableId)} ${isFav?'als Favorit gesetzt':'aus Favoriten entfernt'}`,'info');
  renderTables();
}
let currentTable=null; let basket=new Map();
let currentCommentProduct=null;
let addToOrderId=null;
function openProducts(tid){ addToOrderId=null; currentTable=tid; state.selectedCategory=null; $('#prod-table-label').textContent='Tisch '+tableDisplayNum(tid); basket.clear(); renderProducts(); show('#view-products'); }
function openProductsForOrder(orderId){ const order=state.orders.find(o=>o.id===orderId); if(!order) return; addToOrderId=orderId; currentTable=order.table_id; state.selectedCategory=null; $('#prod-table-label').textContent='Hinzufügen: Tisch '+tableDisplayNum(order.table_id); basket.clear(); renderProducts(); show('#view-products'); }
function contrastColor(hex){ if(!hex) return '#0b0c0e'; const h=hex.replace('#',''); if(h.length!=6) return '#0b0c0e'; const r=parseInt(h[0]+h[1],16), g=parseInt(h[2]+h[3],16), b=parseInt(h[4]+h[5],16); const yiq=((r*299)+(g*587)+(b*114))/1000; return yiq>=160 ? '#0b0c0e':'#ffffff'; }

/* Produktfarbe auf ein Element anwenden (Kacheln im Bediener-/POS-/Station-Grid
   und Item-Zeilen der Bestellkarten). opts.shadow=false laesst den Schlagschatten weg. */
function applyProductColor(el, p, opts){
  if(!p || !p.color) return false;
  if(p.half){
    // Halbe Portion: die freie Haelfte bekommt eine feste helle Flaeche statt
    // transparent. Durchsichtig wuerde im dunklen Schema den Untergrund
    // durchscheinen lassen und die Haelfte des Produktnamens unlesbar machen.
    el.style.background=`linear-gradient(to top, ${p.color} 50%, #ffffff 50%)`;
    el.style.color='#0b0c0e';
  } else {
    el.style.background=p.color;
    el.style.color=contrastColor(p.color);
  }
  el.style.borderColor='rgba(0,0,0,.1)';
  if(!opts || opts.shadow!==false) el.style.boxShadow='0 6px 16px rgba(0,0,0,.08)';
  return true;
}

/* Produktnamen schreiben: jedes Wort auf eine eigene Zeile.
   Bewusst ueber Textknoten statt innerHTML - Produktnamen kommen aus dem Admin. */
function setProductNameLines(el, name){
  el.textContent='';
  const words=String(name||'').split(' ').filter(Boolean);
  words.forEach((w,i)=>{
    if(i>0) el.appendChild(document.createElement('br'));
    el.appendChild(document.createTextNode(w));
  });
}

// === Kategorie-Navigation (zweistufiges Auswahlgrid, Phase 3) ===
function categoryNavActive(){ return (state.config.kategorien||[]).length>=2; }
function filterByCategory(products, cat){
  if(cat===null) return products;
  if(cat==='__sonstige__') return products.filter(p=>!p.kategorie);
  return products.filter(p=>p.kategorie===cat);
}
function buildCategoryTile(label, count, onClick){
  const card=document.createElement('div');
  card.className='product-btn category-tile';
  card.style.userSelect='none'; card.style.webkitUserSelect='none'; card.style.webkitTouchCallout='none';
  const name=document.createElement('div'); name.className='name'; name.textContent=label;
  const sub=document.createElement('div'); sub.className='cat-count'; sub.textContent=`${count} Produkt${count!==1?'e':''}`;
  card.append(name, sub);
  card.addEventListener('click', onClick);
  return card;
}
function buildBackTile(onClick){
  const card=document.createElement('div');
  card.className='product-btn category-back';
  card.style.userSelect='none'; card.style.webkitUserSelect='none'; card.style.webkitTouchCallout='none';
  const ic=document.createElement('span'); ic.className='material-symbols-outlined'; ic.textContent='arrow_back';
  const name=document.createElement('div'); name.className='name'; name.textContent='Zurück';
  card.append(ic, name);
  card.addEventListener('click', onClick);
  return card;
}
// Rendert Kategorie-Kacheln. availableProducts = im Kontext sichtbare Produkte (z.B. Theke-gefiltert).
function renderCategoryTiles(gridEl, availableProducts, onPick){
  const cats=state.config.kategorien||[];
  cats.forEach(cat=>{
    const count=availableProducts.filter(p=>p.kategorie===cat).length;
    if(count===0) return;
    gridEl.appendChild(buildCategoryTile(cat, count, ()=>onPick(cat)));
  });
  const uncat=availableProducts.filter(p=>!p.kategorie).length;
  if(uncat>0) gridEl.appendChild(buildCategoryTile('Sonstige', uncat, ()=>onPick('__sonstige__')));
}

function renderProducts(){
  const grid=$('#products-grid');
  grid.innerHTML='';
  const base=state.products.filter(p=>p.active); // Bediener sieht alle Produkte (Plan 4A)
  // Kategorie-Auswahlebene (nur bei >=2 Kategorien)
  if(categoryNavActive() && state.selectedCategory===null){
    renderCategoryTiles(grid, base, (cat)=>{ state.selectedCategory=cat; renderProducts(); });
    return;
  }
  if(categoryNavActive() && state.selectedCategory!==null){
    grid.appendChild(buildBackTile(()=>{ state.selectedCategory=null; renderProducts(); }));
  }
  const products = categoryNavActive() ? filterByCategory(base, state.selectedCategory) : base;
  products.forEach(p=>{
    const card=document.createElement('div');
    card.className='product-btn product-v1';
    card.dataset.productId=p.id;   // Anker fuer punktuelle Updates in syncProductTile()
    card.style.userSelect='none';
    card.style.webkitUserSelect='none';
    card.style.webkitTouchCallout='none';

    applyProductColor(card, p);

    const minus=document.createElement('button');
    minus.className='minus';
    minus.setAttribute('aria-label','Minus');
    minus.addEventListener('click',(e)=>{
      e.stopPropagation();
      addQty(p.id,-1);
    });

    const name=document.createElement('div');
    name.className='name';
    setProductNameLines(name, p.name);

    const basketItem=basket.get(p.id);
    const qty=basketItem?basketItem.items.length:0;

    const badge=document.createElement('div');
    badge.className='badge';
    badge.textContent=qty;

    const top=document.createElement('div');
    top.className='topbar';
    top.append(minus,badge);

    if(basketItem && basketItem.items.some(it=>it.comment)){
      const commentIcon=document.createElement('span');
      commentIcon.className='comment-icon material-symbols-outlined';
      commentIcon.textContent='chat_bubble';
      card.appendChild(commentIcon);
    }

    card.append(top,name);

    bindLongPress(card, ()=>openCommentDialog(p.id), {onTap:()=>addQty(p.id,+1)});

    grid.appendChild(card);
  });
  updateHeader('#view-products');
  updateSendButton();
}
/* Zaehler am Senden-Knopf. Ohne ihn muss der Bediener die Kacheln absuchen,
   um zu sehen, was im Warenkorb liegt. */
function updateSendButton(){
  const btn=$('#btn-send-header');
  if(!btn) return;
  let n=0;
  basket.forEach(bi=>{ n+=bi.items.length; });
  let badge=btn.querySelector('.btn-badge');
  if(!badge){
    badge=document.createElement('span');
    badge.className='btn-badge';
    btn.appendChild(badge);
  }
  badge.textContent=n;
  badge.style.display=n>0?'':'none';
  btn.classList.toggle('has-items', n>0);
}

/* Aktualisiert genau eine Produktkachel statt das ganze Grid neu zu bauen.
   Ein voller Rebuild ersetzt die Kachel im DOM, bricht damit jede Animation ab
   und kostet bei vielen Produkten spuerbar Zeit. */
function syncProductTile(pid){
  const card=$(`#products-grid .product-btn[data-product-id="${pid}"]`);
  if(!card) return false;
  const basketItem=basket.get(pid);
  const qty=basketItem?basketItem.items.length:0;

  const badge=card.querySelector('.badge');
  if(badge && badge.textContent!==String(qty)){
    badge.textContent=qty;
    // Kurzer Puls, damit die geaenderte Zahl auffaellt
    badge.classList.remove('badge-bump');
    void badge.offsetWidth;   // Reflow erzwingen, sonst startet die Animation nicht neu
    badge.classList.add('badge-bump');
  }

  // Kommentar-Symbol nachziehen
  const hasComment=!!(basketItem && basketItem.items.some(it=>it.comment));
  const icon=card.querySelector('.comment-icon');
  if(hasComment && !icon){
    const el=document.createElement('span');
    el.className='comment-icon material-symbols-outlined';
    el.textContent='chat_bubble';
    card.appendChild(el);
  } else if(!hasComment && icon){
    icon.remove();
  }
  return true;
}

function addQty(pid,delta){
  const basketItem=basket.get(pid);
  if(!basketItem){
    if(delta>0){
      basket.set(pid,{items:[{comment:null}]});
    }
  } else {
    if(delta>0){
      basketItem.items.push({comment:null});
    } else if(delta<0 && basketItem.items.length>0){
      basketItem.items.pop();
      if(basketItem.items.length===0){
        basket.delete(pid);
      }
    }
  }
  // Nur die betroffene Kachel anfassen; voller Rebuild nur, wenn sie fehlt
  if(!syncProductTile(pid)) renderProducts();
  updateSendButton();
}
function orderItemsArray(){
  const items=[];
  basket.forEach((basketItem,pid)=>{
    basketItem.items.forEach(item=>{
      if(item.comment){
        items.push({product_id:pid,comment:item.comment});
      } else {
        items.push(pid);
      }
    });
  });
  return items;
}
async function sendOrder(){
  if(basket.size===0) return uiAlert('Wähle mindestens ein Produkt aus, bevor du die Bestellung sendest.',{title:'Noch nichts ausgewählt'});
  const items=orderItemsArray();
  if(addToOrderId){
    await api(`/api/orders/${addToOrderId}/items`,{method:'POST',body:JSON.stringify({items})});
    const oid=addToOrderId;
    addToOrderId=null;
    basket.clear();
    updateSendButton();   // Zaehler leeren, sonst bleibt die alte Zahl stehen
    state.orders=await api('/api/orders');
    openCashDetail(oid);
  } else {
    await api('/api/orders',{method:'POST',body:JSON.stringify({table_id:currentTable,waiter:state.user,items})});
    basket.clear();
    updateSendButton();
    state.orders=await api('/api/orders');
    renderTables();
    show('#view-tables');
  }
}

/* Cash Detail */
let currentCashOrder=null;
let selectedItems=new Set();

function openCashDetail(orderId){
  currentCashOrder=state.orders.find(o=>o.id===orderId);
  if(!currentCashOrder) return;
  selectedItems.clear();
  renderCashDetail();
  show('#view-cash-detail');
  const hdrRight=$('#hdr-right');
  const tableName=`Tisch ${tableDisplayNum(currentCashOrder.table_id)}`;
  hdrRight.innerHTML=`<strong>${tableName}</strong> · <span class="muted" data-created-at="${currentCashOrder.created_at}">${fmtAgeMinutes(currentCashOrder.created_at)}</span>`;
  hdrRight.classList.remove('hidden');
}

function renderCashDetail(){
  if(!currentCashOrder) return;
  const wrap=$('#cash-detail-content');
  wrap.innerHTML='';

  const itemsList=document.createElement('div');
  itemsList.className='cash-detail-items';

  const unpaidItems=currentCashOrder.items.filter(it=>!it.paid&&!it.cancelled);

  const grouped=new Map();
  unpaidItems.forEach(it=>{
    const key=it.product_id;
    if(!grouped.has(key)) grouped.set(key,{product_id:key,name:productName(key),price:it.price,ids:[]});
    grouped.get(key).ids.push(it.id);
  });

  grouped.forEach(group=>{
    const selectedCount=group.ids.filter(id=>selectedItems.has(id)).length;

    const itemCard=document.createElement('div');
    itemCard.className='cash-detail-item';
    if(selectedCount>0) itemCard.classList.add('selected');

    const left=document.createElement('div');
    left.style.display='flex';
    left.style.alignItems='center';
    left.style.gap='12px';

    const controls=document.createElement('div');
    controls.className='qty-controls';

    const minusBtn=document.createElement('button');
    minusBtn.className='qty-btn';
    minusBtn.textContent='-';
    minusBtn.disabled=selectedCount===0;
    minusBtn.addEventListener('click',(e)=>{
      e.stopPropagation();
      if(selectedCount>0){
        const lastSelected=group.ids.filter(id=>selectedItems.has(id)).pop();
        selectedItems.delete(lastSelected);
        renderCashDetail();
      }
    });

    const qtyDisplay=document.createElement('span');
    qtyDisplay.className='qty-display';
    qtyDisplay.textContent=`${selectedCount}/${group.ids.length}`;

    const plusBtn=document.createElement('button');
    plusBtn.className='qty-btn';
    plusBtn.textContent='+';
    plusBtn.disabled=selectedCount===group.ids.length;
    plusBtn.addEventListener('click',(e)=>{
      e.stopPropagation();
      if(selectedCount<group.ids.length){
        const nextUnselected=group.ids.find(id=>!selectedItems.has(id));
        selectedItems.add(nextUnselected);
        renderCashDetail();
      }
    });

    controls.append(minusBtn,qtyDisplay,plusBtn);

    const nameEl=document.createElement('div');
    nameEl.innerHTML=`<strong>${group.name}</strong>`;

    left.append(controls,nameEl);

    const right=document.createElement('div');
    right.style.display='flex';
    right.style.alignItems='center';
    right.style.gap='8px';
    right.innerHTML=`<strong>${fmtEuro(group.price*selectedCount)}</strong>`;

    // × Stornieren pro Item
    const cancelItemBtn=document.createElement('button');
    cancelItemBtn.className='btn-cancel-item';
    cancelItemBtn.title='1x stornieren';
    cancelItemBtn.textContent='×';
    cancelItemBtn.addEventListener('click',async(e)=>{
      e.stopPropagation();
      const itemId=group.ids[0]; // ältestes Item dieser Gruppe stornieren
      await api(`/api/orders/${currentCashOrder.id}/items/${itemId}`,{method:'DELETE'});
      state.orders=await api('/api/orders');
      currentCashOrder=state.orders.find(o=>o.id===currentCashOrder.id)||null;
      if(!currentCashOrder){ renderTables(); show('#view-tables'); } else { renderCashDetail(); }
      renderTables();
    });
    right.appendChild(cancelItemBtn);

    itemCard.append(left,right);
    itemsList.appendChild(itemCard);
  });

  wrap.appendChild(itemsList);

  const totalAll=unpaidItems.reduce((s,it)=>s+it.price,0);
  const totalSelected=unpaidItems.filter(it=>selectedItems.has(it.id)).reduce((s,it)=>s+it.price,0);
  const totalRest=totalAll-totalSelected;

  const summary=document.createElement('div');
  summary.className='cash-detail-summary';
  summary.innerHTML=`
    <div class="summary-row"><span>Teilsumme:</span><strong>${fmtEuro(totalSelected)}</strong></div>
    <div class="summary-row"><span>Restsumme:</span><strong>${fmtEuro(totalRest)}</strong></div>
    <div class="summary-row total">
      <span>Gesamt:</span>
      <button id="btn-open-change-modal" class="ghost" style="padding:4px 8px;min-height:32px;" title="Rückgeld berechnen">
        <span class="material-symbols-outlined">calculate</span>
      </button>
      <strong>${fmtEuro(totalAll)}</strong>
    </div>
  `;
  wrap.appendChild(summary);

  // Open change modal
  const openChangeBtn=$('#btn-open-change-modal');
  openChangeBtn.addEventListener('click',()=>{
    const toPay=totalSelected>0?totalSelected:totalAll;
    const itemIds=selectedItems.size>0?Array.from(selectedItems):null;
    openChangeModal(toPay, currentCashOrder.id, itemIds);
  });

  const actions=document.createElement('div');
  actions.className='cash-detail-actions';

  const paySelectedBtn=document.createElement('button');
  paySelectedBtn.className='primary';
  paySelectedBtn.innerHTML='<span class="material-symbols-outlined">payments</span> Teilzahlung kassieren';
  paySelectedBtn.disabled=selectedItems.size===0;
  paySelectedBtn.addEventListener('click',async ()=>{
    if(selectedItems.size===0) return;
    await api(`/api/orders/${currentCashOrder.id}/pay-items`,{method:'POST', body:JSON.stringify({itemIds:Array.from(selectedItems)})});
    state.orders=await api('/api/orders');
    currentCashOrder=state.orders.find(o=>o.id===currentCashOrder.id);
    if(!currentCashOrder || currentCashOrder.status==='paid'){
      // Bestellung komplett bezahlt → direkt zurück zur Tisch-Übersicht
      renderTables();
      show('#view-tables');
    } else {
      selectedItems.clear();
      renderCashDetail();
    }
  });

  const payAllBtn=document.createElement('button');
  payAllBtn.className='outline';
  payAllBtn.innerHTML='<span class="material-symbols-outlined">check</span> Alles kassiert';
  payAllBtn.addEventListener('click',async ()=>{
    await api(`/api/orders/${currentCashOrder.id}/pay`,{method:'POST'});
    state.orders=await api('/api/orders');
    // Alles bezahlt → direkt zur Tisch-Übersicht
    renderTables();
    show('#view-tables');
  });

  const addBtn=document.createElement('button');
  addBtn.className='outline';
  addBtn.innerHTML='<span class="material-symbols-outlined">add</span> Hinzufügen';
  addBtn.addEventListener('click',()=>openProductsForOrder(currentCashOrder.id));

  actions.append(addBtn,paySelectedBtn,payAllBtn);
  wrap.appendChild(actions);
}

/* Theke */
function isOrderReady(o){ return o.items.length>0 && o.items.every(i=>i.ready); }
function productName(id){ const p=state.products.find(x=>x.id===id); return p? p.name : ('P'+id); }
function productStation(id){ const p=state.products.find(x=>x.id===id); return p? p.station : null; }
// Theke-Zugehörigkeit: leer/undefined = alle Theken (implizit)
function productThekenOf(id){ const p=state.products.find(x=>x.id===id); return (p&&Array.isArray(p.theken))?p.theken:[]; }
function productInTheke(id, theke){ if(!theke) return true; const t=productThekenOf(id); return t.length===0 || t.includes(theke); }
function itemInSelectedTheke(item){ return productInTheke(item.product_id, state.selectedTheke); }
// Eine Order "betrifft" die Theke: POS-Order mit passender theke ODER ein Item-Produkt gehört zur Theke
function orderInTheke(order, theke){ if(!theke) return true; if(order.theke===theke) return true; return (order.items||[]).some(it=>!it.cancelled && productInTheke(it.product_id, theke)); }
async function renderTheke(){
  // Speichere Scroll-Positionen aller scrollbaren Elemente mit eindeutigen Selektoren
  const scrollableSelectors = [
    '#theke-columns .theke-col',
    '#theke-columns .bediener-column',
    '#theke-columns .pos-column',
    '#theke-columns .pos-products-area'
  ];

  const scrollPositions = new Map();
  scrollableSelectors.forEach(selector => {
    const elements = document.querySelectorAll(selector);
    elements.forEach((el, index) => {
      const key = `${selector}[${index}]`;
      scrollPositions.set(key, el.scrollTop);
    });
  });

  if(state.selectedStation){
    renderStationMode();
  } else if(state.posMode){
    renderPOSModeWithHybrid();
  } else {
    renderKitchenMode();
  }
  // Ab jetzt duerfen neu auftauchende Wellen einfliegen. Beim allerersten
  // Aufbau nicht, sonst animiert die komplette Ansicht auf einmal.
  state.thekeRendered=true;
  updateHeader('#view-theke');

  // Stelle Scroll-Positionen wieder her (mit requestAnimationFrame für besseres Timing)
  requestAnimationFrame(() => {
    scrollableSelectors.forEach(selector => {
      const elements = document.querySelectorAll(selector);
      elements.forEach((el, index) => {
        const key = `${selector}[${index}]`;
        if (scrollPositions.has(key)) {
          el.scrollTop = scrollPositions.get(key);
        }
      });
    });
  });
}

function renderStationMode(){
  const cols=$('#theke-columns');
  cols.innerHTML='';
  cols.className='station-mode-grid';

  // Sammle alle order_items für die gewählte Station, die noch nicht bereit sind
  const stationItems=[];
  state.orders.filter(o=>o.status!=='picked').forEach(order=>{
    order.items.forEach(item=>{
      const station=productStation(item.product_id);
      if(station===state.selectedStation && !item.ready && !item.cancelled && itemInSelectedTheke(item)){
        stationItems.push({
          ...item,
          order_id:order.id,
          table_id:order.table_id,
          waiter:order.waiter,
          created_at:order.created_at
        });
      }
    });
  });

  if(stationItems.length===0){
    const empty=document.createElement('div');
    empty.className='muted text-center';
    empty.style.padding='32px';
    empty.innerHTML='<h3>Keine Bestellungen</h3>';
    cols.appendChild(empty);
    return;
  }

  // Jede Einheit bekommt ihre eigene Kachel (jede order_items-Zeile ist genau
  // ein Stueck). Zwei offene Radler = zwei Kacheln, kein Zaehler. Aelteste zuerst,
  // innerhalb einer Bestellung in Eingabereihenfolge.
  stationItems.sort((a,b)=>(new Date(a.created_at)-new Date(b.created_at)) || (a.id-b.id));

  // Erstelle Produkt-Kacheln (wie in Bedienungs-Ansicht)
  const grid=document.createElement('div');
  grid.className='grid products';

  stationItems.forEach(item=>{
    const product=state.products.find(p=>p.id===item.product_id);
    const itemName=productName(item.product_id);
    const card=document.createElement('div');
    card.className='product-btn product-v1 station-product';
    card.style.position='relative';

    applyProductColor(card, product);

    // Statt der Tischnummer steht auf der Kachel, wer bestellt hat
    const waiterLabel=item.waiter==='POS'?'POS':(item.waiter||'');

    // Kommentar anzeigen (falls vorhanden)
    let commentDiv=null;
    if(item.comment){
      // Name-Container mit Tischnummer oben und Produktname darunter
      const name=document.createElement('div');
      name.className='name';
      name.style.flex='1';
      name.style.display='flex';
      name.style.flexDirection='column';
      name.style.alignItems='center';
      name.style.justifyContent='center';
      name.style.position='relative';
      name.style.zIndex='1';
      name.style.gap='4px';

      const tableNumsInName=document.createElement('div');
      tableNumsInName.className='station-table';
      tableNumsInName.textContent=waiterLabel;
      tableNumsInName.style.fontSize='14px';
      tableNumsInName.style.fontWeight='700';
      tableNumsInName.style.opacity='0.75';

      const productNameText=document.createElement('div');
      productNameText.className='station-name-text';
      productNameText.textContent=itemName;
      productNameText.style.fontSize='1.5em';
      productNameText.style.fontWeight='800';

      name.append(tableNumsInName,productNameText);

      commentDiv=document.createElement('div');
      commentDiv.className='item-comment station-comment';
      commentDiv.style.display='flex';
      commentDiv.style.alignItems='center';
      commentDiv.style.gap='4px';
      commentDiv.style.fontSize='13px';
      commentDiv.style.fontWeight='600';
      commentDiv.style.opacity='0.85';
      commentDiv.style.marginTop='6px';
      commentDiv.style.padding='0 8px';
      commentDiv.style.textAlign='center';
      commentDiv.style.justifyContent='center';
      commentDiv.style.fontStyle='italic';
      commentDiv.style.position='relative';
      commentDiv.style.zIndex='1';
      const icon=document.createElement('span');
      icon.className='material-symbols-outlined';
      icon.style.fontSize='16px';
      icon.textContent='chat_bubble';
      commentDiv.appendChild(icon);
      commentDiv.appendChild(document.createTextNode(item.comment));

      card.append(name,commentDiv);
    } else {
      // Standard: Name zentral, Tischnummer unten
      const name=document.createElement('div');
      name.className='name';
      name.textContent=itemName;
      name.style.fontSize='1.5em';
      name.style.fontWeight='800';
      name.style.flex='1';
      name.style.display='flex';
      name.style.alignItems='center';
      name.style.justifyContent='center';
      name.style.position='relative';
      name.style.zIndex='1';

      const tables=document.createElement('div');
      tables.className='station-table';
      tables.textContent=waiterLabel;
      tables.style.fontSize='16px';
      tables.style.opacity='0.75';
      tables.style.textAlign='center';
      tables.style.fontWeight='700';
      tables.style.width='100%';

      card.append(name,tables);
    }

    card.addEventListener('click',async ()=>{
      // Genau diese Einheit als bereit markieren, ihre Kachel verschwindet
      await api(`/api/orders/${item.order_id}/items/${item.id}/ready`,{method:'POST'});
      state.orders=await api('/api/orders');
      renderTheke();
    });

    grid.appendChild(card);
  });

  cols.appendChild(grid);
}

// Helper: aus Orders eine flache Liste von [{order, batch, items}] machen.
// Eine Batch ist renderbar, wenn min. ein Item noch nicht picked und nicht cancelled ist.
function getRenderableBatches(orders){
  const result=[];
  orders.forEach(o=>{
    const map=new Map();
    o.items.forEach(it=>{
      if(it.cancelled) return;
      if(!itemInSelectedTheke(it)) return; // Theke-Filter: nur Items dieser Theke
      const b=it.batch||1;
      if(!map.has(b)) map.set(b,[]);
      map.get(b).push(it);
    });
    Array.from(map.keys()).sort((a,b)=>a-b).forEach(b=>{
      const items=map.get(b);
      if(items.every(it=>it.picked)) return;
      result.push({order:o, batch:b, items});
    });
  });
  return result;
}

/* Wie lange eine Bestellung warten darf, bevor die Karte sich meldet.
   Flighty-Prinzip: die dringendste Information bekommt die staerkste
   visuelle Behandlung, statt nur eine groessere Zahl anzuzeigen. */
const AGE_WARN_MIN=5;
const AGE_LATE_MIN=10;

function ageMinutes(s){ return Math.max(0,Math.floor((Date.now()-toDate(s).getTime())/60000)); }
function ageLevel(s){
  const m=ageMinutes(s);
  if(m>=AGE_LATE_MIN) return 'late';
  if(m>=AGE_WARN_MIN) return 'warn';
  return 'fresh';
}

/* Faerbt eine Positionszeile passend zu ihrem ready-Zustand.
   Eine Funktion fuer Aufbau und Umschalten, damit beide nie auseinanderlaufen. */
function paintItemLine(line, it){
  line.classList.toggle('ready', !!it.ready);
  line.classList.remove('has-product-color');
  line.style.background='';
  line.style.color='';
  line.style.borderColor='';
  line.style.boxShadow='';
  // Produktfarbe nur im offenen Zustand; bei "bereit" gewinnt das gruene Styling
  if(!it.ready){
    const prod=state.products.find(p=>p.id===it.product_id);
    if(applyProductColor(line, prod, {shadow:false})) line.classList.add('has-product-color');
  }
}

/* Zieht Statusanzeige und Knopfbeschriftung einer Karte nach, ohne sie neu zu bauen. */
function refreshBatchCardStatus(card, batchItems){
  const allReady=batchItems.length>0 && batchItems.every(it=>it.ready);
  const layout=(state.config.theke_layout||'badges');
  const bd=card.querySelector('.status');
  if(bd){
    bd.className='status '+(allReady?'ready':'open');
    bd.textContent=allReady?'bereit':'offen';
  }
  if(layout!=='badges'){
    card.classList.toggle('bg-ready', allReady);
    card.classList.toggle('bg-open', !allReady);
  }
  const btn=card.querySelector('.btn-all-ready');
  if(btn){
    btn.classList.toggle('btn-undo-ready', allReady);
    btn.textContent=allReady?'Alle offen':'Alle bereit';
  }
}

// Helper: baut eine Card für eine einzelne Batch
function buildBatchCard(o, batch, batchItems){
  const card=document.createElement('div');
  card.className='order-card';
  card.dataset.batchKey=`${o.id}:${batch}`;
  card.dataset.ageLevel=ageLevel(o.created_at);
  if(o.waiter && o.waiter.startsWith('SIM_')) card.dataset.waiter = o.waiter;

  // Neu eingetroffene Welle einmalig einfliegen lassen, damit an der Theke
  // sofort klar ist, was dazugekommen ist. Beim ersten Aufbau nach dem
  // Anmelden wird nichts animiert, sonst zappelt die ganze Ansicht.
  const key=card.dataset.batchKey;
  if(!state.seenBatches.has(key)){
    state.seenBatches.add(key);
    if(state.thekeRendered) card.classList.add('card-enter');
  }

  const layout=(state.config.theke_layout||'badges');
  const row=document.createElement('div');
  row.className='row';
  const meta=document.createElement('div');
  meta.className='meta';
  const h=document.createElement('div');
  const tableLabel=o.waiter==='POS'?'POS':`Tisch ${tableDisplayNum(o.table_id)}`;
  const batchSuffix=batch>1?` · +${batch-1}`:'';
  h.innerHTML=`<strong>${tableLabel}${batchSuffix}</strong>`;
  const t=document.createElement('div');
  t.className='time';
  t.dataset.createdAt=o.created_at;
  t.textContent=fmtAgeMinutes(o.created_at);
  meta.append(h,t);
  const allReady=batchItems.every(it=>it.ready);
  if(layout==='badges'){
    const bd=document.createElement('span');
    bd.className='status '+(allReady?'ready':'open');
    bd.textContent=allReady?'bereit':'offen';
    row.append(meta,bd);
  } else {
    card.classList.add(allReady?'bg-ready':'bg-open');
    row.append(meta,document.createElement('span'));
  }
  card.appendChild(row);
  const itemsDiv=document.createElement('div');
  itemsDiv.className='items';
  batchItems.forEach(it=>{
    const line=document.createElement('div');
    line.className='item';
    setProductNameLines(line, productName(it.product_id));
    paintItemLine(line, it);
    if(it.comment){
      const commentDiv=document.createElement('div');
      commentDiv.className='item-comment';
      const icon=document.createElement('span');
      icon.className='material-symbols-outlined';
      icon.textContent='chat_bubble';
      commentDiv.appendChild(icon);
      commentDiv.appendChild(document.createTextNode(it.comment));
      line.appendChild(commentDiv);
    }
    // Sofort umschalten, dann erst den Server fragen. Die Theke soll nicht auf
    // zwei Netzwerkrunden warten, bevor sich sichtbar etwas tut.
    line.addEventListener('click', async ()=>{
      if(line.dataset.busy) return;
      line.dataset.busy='1';
      const prev=!!it.ready;
      it.ready=!prev;
      paintItemLine(line, it);
      refreshBatchCardStatus(card, batchItems);
      try{
        await api(`/api/orders/${o.id}/items/${it.id}/toggle-ready`,{method:'PATCH'});
      }catch(e){
        it.ready=prev;                       // Server hat nicht angenommen
        paintItemLine(line, it);
        refreshBatchCardStatus(card, batchItems);
        showNotification('Konnte nicht gespeichert werden','warning');
      }finally{
        delete line.dataset.busy;
      }
    });
    itemsDiv.appendChild(line);
  });
  card.appendChild(itemsDiv);
  // Gesamtbetrag als Kassenbon-Zeile ueber den Buttons - auf jeder Bestellkarte.
  // Summiert genau die Positionen dieser Karte (Batch + Theke-Filter), damit der
  // Betrag zu den Zeilen darueber passt und mehrere Batches sich nicht doppeln.
  const totalRow=document.createElement('div');
  totalRow.className='card-total';
  const lbl=document.createElement('span');
  lbl.className='lbl';
  lbl.textContent='Gesamt';
  const amt=document.createElement('strong');
  amt.textContent=fmtEuro(batchItems.filter(it=>!it.cancelled).reduce((s,it)=>s+(it.price||0),0));
  totalRow.append(lbl,amt);
  card.appendChild(totalRow);
  const actions=document.createElement('div');
  actions.className='actions';
  const leftA=document.createElement('div');
  leftA.className='left';
  const rightA=document.createElement('div');
  rightA.className='right';
  // Symmetrischer Toggle: quittiert die Welle, und nimmt bei erneutem Druck genau
  // das zurueck, was der vorige Klick gesetzt hat.
  const allReadyBtn=document.createElement('button');
  allReadyBtn.className='outline order-action-btn btn-all-ready'+(allReady?' btn-undo-ready':'');
  allReadyBtn.textContent=allReady?'Alle offen':'Alle bereit';
  allReadyBtn.addEventListener('click', async ()=>{
    if(allReadyBtn.disabled) return;
    const target=!batchItems.every(it=>it.ready);
    const prev=batchItems.map(it=>!!it.ready);
    batchItems.forEach(it=>{ it.ready=target; });
    card.querySelectorAll('.items .item').forEach((line,i)=>paintItemLine(line, batchItems[i]));
    refreshBatchCardStatus(card, batchItems);
    allReadyBtn.disabled=true;
    try{
      await api(`/api/orders/${o.id}/batch/${batch}/ready`,{method:'POST', body:JSON.stringify({ready:target})});
    }catch(e){
      batchItems.forEach((it,i)=>{ it.ready=prev[i]; });
      card.querySelectorAll('.items .item').forEach((line,i)=>paintItemLine(line, batchItems[i]));
      refreshBatchCardStatus(card, batchItems);
      showNotification('Konnte nicht gespeichert werden','warning');
    }finally{
      allReadyBtn.disabled=false;
    }
  });
  leftA.appendChild(allReadyBtn);
  const pick=document.createElement('button');
  pick.className='outline order-action-btn';
  pick.textContent='Abgeholt';
  pick.addEventListener('click', async ()=>{
    if(pick.disabled) return;
    pick.disabled=true;
    // Karte sofort ausblenden; sie verschwindet ohnehin beim naechsten Render
    card.classList.add('card-leave');
    try{
      await api(`/api/orders/${o.id}/batch/${batch}/pickup`,{method:'POST'});
      state.seenBatches.delete(key);
    }catch(e){
      card.classList.remove('card-leave');
      pick.disabled=false;
      showNotification('Konnte nicht gespeichert werden','warning');
    }
  });
  rightA.appendChild(pick);
  actions.append(leftA,rightA);
  card.appendChild(actions);
  return card;
}

function renderKitchenMode(){
  const cols=$('#theke-columns');
  cols.innerHTML='';
  cols.className='theke-columns';

  // Sammle aktive Bediener (aus Sessions) - POS NICHT filtern
  const activeWaiters=state.sessions.map(s=>s.waiter);

  // Gruppiere Orders nach Bediener. Order ist sichtbar wenn min. ein Item noch nicht picked.
  const groups={};
  state.orders.filter(o=>o.items.some(it=>!it.picked && !it.cancelled)).forEach(o=>{
    (groups[o.waiter]=groups[o.waiter]||[]).push(o);
  });

  // Alle Bediener mit offenen Bestellungen einschließen, auch wenn nicht mehr eingeloggt
  const allWaiters=[...activeWaiters];
  Object.keys(groups).forEach(w=>{ if(!allWaiters.includes(w)) allWaiters.push(w); });

  // Sortierung: POS immer ganz rechts, dann bei mehr als 4 Bedienungen -> mit Bestellungen zuerst, sonst alphabetisch
  let waiters;
  if(allWaiters.length>4){
    waiters=allWaiters.sort((a,b)=>{
      // POS immer ans Ende (ganz rechts)
      if(a==='POS') return 1;
      if(b==='POS') return -1;
      const hasOrdersA=(groups[a]&&groups[a].length>0)?1:0;
      const hasOrdersB=(groups[b]&&groups[b].length>0)?1:0;
      if(hasOrdersB!==hasOrdersA) return hasOrdersB-hasOrdersA;
      return a.localeCompare(b);
    });
  } else {
    waiters=allWaiters.sort((a,b)=>{
      // POS immer ans Ende (ganz rechts)
      if(a==='POS') return 1;
      if(b==='POS') return -1;
      return a.localeCompare(b);
    });
  }

  // Wenn nur ein Bediener, füge CSS-Klasse hinzu
  if(waiters.length===1){
    cols.classList.add('single-waiter');
  }

  waiters.forEach(w=>{
    const list=groups[w]||[];
    list.sort((a,b)=>a.created_at.localeCompare(b.created_at));

    const col=document.createElement('div');
    col.className='theke-col';

    const title=document.createElement('div');
    title.className='col-title';
    title.textContent=w||'—';
    col.appendChild(title);

    const batchCards=getRenderableBatches(list);
    if(batchCards.length===0){
      const empty=document.createElement('div');
      empty.className='muted';
      empty.style.padding='12px';
      empty.style.textAlign='center';
      empty.textContent='Keine offenen Bestellungen';
      col.appendChild(empty);
    } else {
      batchCards.forEach(({order, batch, items})=>{
        col.appendChild(buildBatchCard(order, batch, items));
      });
    }

    cols.appendChild(col);
  });
}

function renderPOSModeWithHybrid(){
  const cols=$('#theke-columns');
  cols.innerHTML='';

  // Berechne Layout basierend auf Anzahl Bediener
  const activeBediener=state.sessions.filter(s=>s.waiter!=='Theke' && s.waiter!=='Admin').length;

  // Layout-Aufteilung: 30/70 bei 0-1 Bedienungen, 50/50 bei 2+ Bedienungen
  const layout=activeBediener>=2?'50-50':'30-70';
  cols.className=`hybrid-layout split-${layout}`;

  // Linke Spalte: Bediener-Bestellungen + POS-Bestellungen
  const bedienerCol=document.createElement('div');
  bedienerCol.className='bediener-column';
  if(activeBediener>=1){
    // Ab 1 Bedienung: zwei Spalten nebeneinander (Bedienung + POS) + vertikale Buttons
    bedienerCol.classList.add('multi-waiter');
    bedienerCol.classList.add('vertical-layout');
  }
  renderBedienerColumn(bedienerCol);
  cols.appendChild(bedienerCol);

  // Rechte Spalte: POS (Produkte + Checkout)
  const posCol=document.createElement('div');
  posCol.className='pos-column';
  renderPOSColumn(posCol);
  cols.appendChild(posCol);
}

function renderBedienerColumn(container){
  // Verwende exakt die gleiche Logik wie Kitchen Mode, aber ohne .theke-columns Wrapper
  const activeWaiters=state.sessions.filter(s=>s.waiter!=='Theke' && s.waiter!=='Admin').map(s=>s.waiter);

  const groups={};
  state.orders.filter(o=>o.items.some(it=>!it.picked && !it.cancelled)).forEach(o=>{
    (groups[o.waiter]=groups[o.waiter]||[]).push(o);
  });

  const allWaiters=[...activeWaiters];
  Object.keys(groups).forEach(w=>{ if(!allWaiters.includes(w)) allWaiters.push(w); });

  let waiters;
  if(allWaiters.length>4){
    waiters=allWaiters.sort((a,b)=>{
      if(a==='POS') return 1;
      if(b==='POS') return -1;
      const hasOrdersA=(groups[a]&&groups[a].length>0)?1:0;
      const hasOrdersB=(groups[b]&&groups[b].length>0)?1:0;
      if(hasOrdersB!==hasOrdersA) return hasOrdersB-hasOrdersA;
      return a.localeCompare(b);
    });
  } else {
    waiters=allWaiters.sort((a,b)=>{
      if(a==='POS') return 1;
      if(b==='POS') return -1;
      return a.localeCompare(b);
    });
  }

  waiters.forEach(w=>{
    const list=groups[w]||[];
    if(list.length===0) return;
    list.sort((a,b)=>a.created_at.localeCompare(b.created_at));

    const col=document.createElement('div');
    col.className='theke-col';

    const title=document.createElement('div');
    title.className='col-title';
    title.textContent=w||'—';
    col.appendChild(title);

    const batchCards=getRenderableBatches(list);
    if(batchCards.length===0) return; // nach Theke-Filter nichts uebrig -> Spalte weglassen
    batchCards.forEach(({order, batch, items})=>{
      col.appendChild(buildBatchCard(order, batch, items));
    });

    container.appendChild(col);
  });
}

function renderPOSColumn(container){
  // Obere 70%: Produkte
  const productsArea=document.createElement('div');
  productsArea.className='pos-products-area';

  const prodGrid=document.createElement('div');
  prodGrid.className='grid products';

  let posBase=state.products.filter(p=>p.active && productInTheke(p.id, state.selectedTheke));
  // Kategorie-Navigation (Phase 3): erst Kategorie-Kacheln, dann Produkte
  if(categoryNavActive() && state.selectedCategory===null){
    renderCategoryTiles(prodGrid, posBase, (cat)=>{ state.selectedCategory=cat; renderTheke(); });
    posBase=[];
  } else if(categoryNavActive() && state.selectedCategory!==null){
    prodGrid.appendChild(buildBackTile(()=>{ state.selectedCategory=null; renderTheke(); }));
    posBase=filterByCategory(posBase, state.selectedCategory);
  }
  posBase.forEach(p=>{
    const card=document.createElement('div');
    card.className='product-btn product-v1';
    card.dataset.productId=p.id;   // Anker fuer syncPOSTile()
    applyProductColor(card, p);
    const minus=document.createElement('button');
    minus.className='minus';
    minus.setAttribute('aria-label','Minus');
    minus.addEventListener('click',(e)=>{
      e.stopPropagation();
      addPOSQty(p.id,-1);
    });
    const name=document.createElement('div');
    name.className='name';
    setProductNameLines(name, p.name);
    const badge=document.createElement('div');
    badge.className='badge';
    badge.textContent=state.posBasket.get(p.id)||0;
    const top=document.createElement('div');
    top.className='topbar';
    top.append(minus,badge);
    card.append(top,name);
    card.addEventListener('click',()=>addPOSQty(p.id,+1));
    prodGrid.appendChild(card);
  });

  productsArea.appendChild(prodGrid);
  container.appendChild(productsArea);

  container.appendChild(buildPOSCheckout());

  // Nach Layout: Grid dynamisch vermessen (zweimal, damit Grid-Row-Sizing 1fr stabil ist)
  requestAnimationFrame(()=>{ layoutPOSGrid(); requestAnimationFrame(layoutPOSGrid); });
}

/* Baut den Checkout-Bereich. Eigene Funktion, damit ein Mengenwechsel nur
   diesen Block ersetzt statt das ganze Thekenlayout samt Grid-Vermessung
   neu aufzubauen. */
function buildPOSCheckout(){
  const checkoutArea=document.createElement('div');
  checkoutArea.className='pos-checkout-area';

  const title=document.createElement('h3');
  title.textContent='Aktuelle Bestellung';
  checkoutArea.appendChild(title);

  const itemsList=document.createElement('div');
  itemsList.className='pos-items-list';

  let total=0;
  if(state.posBasket.size===0){
    const empty=document.createElement('div');
    empty.className='muted';
    empty.textContent='Keine Produkte ausgewählt';
    itemsList.appendChild(empty);
  } else {
    state.posBasket.forEach((qty,pid)=>{
      const prod=state.products.find(p=>p.id===pid);
      if(!prod) return;
      const item=document.createElement('div');
      item.className='pos-item';
      const left=document.createElement('div');
      left.innerHTML=`<strong>${qty}x</strong> ${prod.name}`;
      const right=document.createElement('div');
      const itemTotal=(prod.price_cents/100)*qty;
      total+=itemTotal;
      right.innerHTML=`<strong>${fmtEuro(itemTotal)}</strong>`;
      item.append(left,right);
      itemsList.appendChild(item);
    });
  }

  checkoutArea.appendChild(itemsList);

  const totalRow=document.createElement('div');
  totalRow.className='pos-total';
  const totalLabel=document.createElement('div');
  totalLabel.innerHTML='<strong>Gesamt:</strong>';

  const changeBtn=document.createElement('button');
  changeBtn.className='ghost';
  changeBtn.style.padding='4px 8px';
  changeBtn.style.minHeight='32px';
  changeBtn.title='Rückgeld berechnen';
  changeBtn.innerHTML='<span class="material-symbols-outlined">calculate</span>';
  changeBtn.addEventListener('click',()=>{
    if(total>0) openChangeModal(total);
  });

  const totalAmount=document.createElement('div');
  totalAmount.innerHTML=`<strong style="font-size:20px">${fmtEuro(total)}</strong>`;
  totalRow.append(totalLabel,changeBtn,totalAmount);
  checkoutArea.appendChild(totalRow);

  const actions=document.createElement('div');
  actions.className='pos-actions';

  const clearBtn=document.createElement('button');
  clearBtn.className='outline';
  clearBtn.textContent='Abbrechen';
  clearBtn.addEventListener('click',()=>{
    state.posBasket.clear();
    renderTheke();
  });

  // Check if station mode is active
  const stationActive=state.selectedStation!==null;

  if(stationActive){
    // Two-step process: Send -> Pay
    const sendBtn=document.createElement('button');
    sendBtn.className='primary';
    sendBtn.innerHTML='<span class="material-symbols-outlined">send</span> Bestellung senden';
    sendBtn.disabled=state.posBasket.size===0;
    sendBtn.addEventListener('click', async ()=>{
      if(state.posBasket.size===0) return;
      const items=[];
      state.posBasket.forEach((q,pid)=>{ for(let i=0;i<q;i++) items.push(pid); });
      const posTable=state.tables.find(t=>t.name==='POS');
      const table=posTable?.id||(state.tables[0]?.id||1);
      const orderResponse=await api('/api/orders',{method:'POST', body:JSON.stringify({ table_id: table, waiter: 'POS', items, theke: state.selectedTheke })});
      state.currentPOSOrderId=orderResponse.id;
      state.orders=await api('/api/orders');
      openChangeModal(orderResponse.total_cents/100, orderResponse.id);
      state.posBasket.clear();
      renderTheke();
    });

    actions.append(clearBtn,sendBtn);
  } else {
    // One-step process: Pay directly (original behavior)
    const payBtn=document.createElement('button');
    payBtn.className='primary';
    payBtn.innerHTML='<span class="material-symbols-outlined">check</span> Alles kassiert';
    payBtn.disabled=state.posBasket.size===0;
    payBtn.addEventListener('click', async ()=>{
      if(state.posBasket.size===0) return;
      const items=[];
      state.posBasket.forEach((q,pid)=>{ for(let i=0;i<q;i++) items.push(pid); });
      const posTable=state.tables.find(t=>t.name==='POS');
      const table=posTable?.id||(state.tables[0]?.id||1);
      const orderRes=await api('/api/orders',{method:'POST', body:JSON.stringify({ table_id: table, waiter: 'POS', items, theke: state.selectedTheke })});
      await api(`/api/orders/${orderRes.id}/pay`,{method:'POST'});
      state.posBasket.clear();
      state.orders=await api('/api/orders');
      renderTheke();
    });

    actions.append(clearBtn,payBtn);
  }

  checkoutArea.appendChild(actions);
  return checkoutArea;
}

/* Mengenwechsel an der Theke: Kachel-Zahl und Checkout punktuell nachziehen.
   Frueher lief hier renderTheke(), was das komplette Layout inklusive
   Grid-Vermessung neu aufgebaut hat - bei jedem einzelnen Tipp. */
function syncPOSTile(pid){
  const card=$(`.pos-products-area .product-btn[data-product-id="${pid}"]`);
  if(!card) return false;
  const badge=card.querySelector('.badge');
  const qty=state.posBasket.get(pid)||0;
  if(badge && badge.textContent!==String(qty)){
    badge.textContent=qty;
    badge.classList.remove('badge-bump');
    void badge.offsetWidth;
    badge.classList.add('badge-bump');
  }
  return true;
}

function addPOSQty(pid,delta){
  const q=Math.max(0,(state.posBasket.get(pid)||0)+delta);
  if(q===0) state.posBasket.delete(pid);
  else state.posBasket.set(pid,q);

  const old=$('.pos-checkout-area');
  if(syncPOSTile(pid) && old){
    // Nur den Checkout tauschen, das Produktgrid bleibt unberuehrt stehen
    old.replaceWith(buildPOSCheckout());
  } else {
    renderTheke();
  }
}

/* Dynamisches POS-Produkt-Grid: Füllt verfügbare Fläche perfekt aus.
   Wählt cols/rows automatisch so, dass Kacheln möglichst groß und nahe Quadrat sind. */
function layoutPOSGrid(){
  const area=document.querySelector('.pos-products-area');
  if(!area) return;
  const grid=area.querySelector('.grid.products');
  if(!grid) return;
  const tiles=grid.querySelectorAll('.product-btn');
  const n=tiles.length;
  if(n===0) return;

  const cs=getComputedStyle(area);
  const padL=parseFloat(cs.paddingLeft)||0;
  const padR=parseFloat(cs.paddingRight)||0;
  const padT=parseFloat(cs.paddingTop)||0;
  const padB=parseFloat(cs.paddingBottom)||0;
  const W=area.clientWidth-padL-padR;
  const H=area.clientHeight-padT-padB;
  if(W<=0||H<=0) return;

  const gap=8;
  const minTile=60;

  // Alle möglichen Spaltenanzahlen ausprobieren, Score = Fläche mit Aspekt-Ratio-Bias
  let best=null;
  for(let cols=1;cols<=n;cols++){
    const rows=Math.ceil(n/cols);
    const cw=(W-(cols-1)*gap)/cols;
    const ch=(H-(rows-1)*gap)/rows;
    if(cw<minTile||ch<minTile) continue;
    const ar=cw/ch;
    const arPenalty=Math.pow(Math.log(ar),2); // 0 bei ar=1
    const score=(cw*ch)-arPenalty*1500;
    if(!best||score>best.score) best={cols,rows,cw,ch,score};
  }

  // Fallback: wenn minTile unterschritten, einfach quadratisch-annähernd
  if(!best){
    const cols=Math.max(1,Math.ceil(Math.sqrt(n*W/Math.max(H,1))));
    const rows=Math.ceil(n/cols);
    const cw=Math.max(40,(W-(cols-1)*gap)/cols);
    const ch=Math.max(40,(H-(rows-1)*gap)/rows);
    best={cols,rows,cw,ch};
  }

  grid.style.gridTemplateColumns=`repeat(${best.cols}, 1fr)`;
  grid.style.gridAutoRows=`${best.ch}px`;
  grid.style.gap=`${gap}px`;

  tiles.forEach(el=>{
    el.style.aspectRatio='auto';
    el.style.maxHeight='none';
    el.style.minHeight='0';
    el.style.height=`${best.ch}px`;
  });
}

/* POS History (Theke): zeigt ALLE Bestellungen (alle Bediener + POS, alle Status) - geladen vom Server */
async function loadPOSHistory(){
  try {
    state.posHistory = await api('/api/orders/history?limit=50');
  } catch(e) {
    console.error('Failed to load POS history:', e);
    return;
  }
  if(!$('#view-pos-history').classList.contains('hidden')) renderPOSHistory();
}

async function openPOSHistory(){
  await loadPOSHistory();
  show('#view-pos-history');
}

function renderPOSHistory(){
  const wrap=$('#pos-history-list');
  if(!wrap) return;
  wrap.innerHTML='';
  // Theke-History: nur Orders, die die gewählte Theke betreffen (POS-Theke oder Item-Produkt der Theke)
  const orders=(state.posHistory||[]).filter(o=>orderInTheke(o, state.selectedTheke));
  if(orders.length===0){
    wrap.innerHTML='<div class="muted">Keine Bestellungen vorhanden.</div>';
    return;
  }
  orders.forEach(o=>{
    const card=document.createElement('div');
    card.className='cash-card';

    const row=document.createElement('div');
    row.className='row';

    const left=document.createElement('div');
    const createdDate=toDate(o.created_at);
    const timeStr=createdDate.toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit'});
    const dateStr=createdDate.toLocaleDateString('de-DE',{day:'2-digit',month:'2-digit'});
    const tableLabel=o.waiter==='POS'?'POS':`Tisch ${tableDisplayNum(o.table_id)}`;
    left.innerHTML=`<strong>${o.waiter} #${o.id}</strong> · <span class="muted">${tableLabel} · ${dateStr} ${timeStr}</span>`;

    const middle=document.createElement('div');
    const badge=document.createElement('span');
    let label='offen', cls='status-open';
    const allItemsPaid=o.items.length>0 && o.items.every(it=>it.paid||it.cancelled);
    if(o.status==='cancelled'){ label='storniert'; cls='status-cancelled'; }
    else if(o.status==='paid'||allItemsPaid){ label='bezahlt'; cls='status-paid'; }
    else if(o.status==='picked'){ label='abgeholt'; cls='status-picked'; }
    else if(o.status==='ready'){ label='bereit'; cls='status-ready'; }
    badge.className=`status-badge ${cls}`;
    badge.textContent=label;
    middle.appendChild(badge);

    const right=document.createElement('div');
    const total=o.items.filter(it=>!it.cancelled).reduce((s,it)=>s+it.price,0);
    right.innerHTML=`<strong>${fmtEuro(total)}</strong>`;

    row.append(left,middle,right);
    card.appendChild(row);

    card.appendChild(buildHistoryItems(o));

    wrap.appendChild(card);
  });
}

/* Waiter History – die letzten 50 eigenen Bestellungen */
async function loadWaiterHistory(){
  if(!state.user) return;
  try{
    state.waiterHistory=await api(`/api/orders/history?waiter=${encodeURIComponent(state.user)}&limit=50`);
  }catch(e){
    console.error('Failed to load waiter history:',e);
    return;
  }
  if(!$('#view-orders-history').classList.contains('hidden')) renderWaiterHistory();
}

async function openWaiterHistory(){
  await loadWaiterHistory();
  show('#view-orders-history');
}

/* Positionsliste einer Bestellung fuer die Verlaufsansichten.
   Gruppiert nach Produkt UND Einzelpreis, damit nachtraegliche Preisaenderungen
   nicht stillschweigend zusammengefasst werden. Vier Spalten: Menge, Name,
   Einzelpreis, Zeilensumme. */
function buildHistoryItems(order){
  const items=document.createElement('div');
  items.className='items history-items';
  items.style.marginTop='8px';

  const grouped=new Map();
  (order.items||[]).filter(it=>!it.cancelled).forEach(it=>{
    const name=productName(it.product_id);
    const key=`${name}|${it.price}`;
    if(!grouped.has(key)) grouped.set(key,{name, price:it.price, qty:0});
    grouped.get(key).qty++;
  });

  grouped.forEach(g=>{
    const line=document.createElement('div');
    line.className='item history-item';

    const qty=document.createElement('span');
    qty.className='hi-qty';
    qty.textContent=`${g.qty}x`;

    const name=document.createElement('span');
    name.className='hi-name';
    name.textContent=g.name;

    const unit=document.createElement('span');
    unit.className='hi-unit muted';
    unit.textContent=`à ${fmtEuro(g.price)}`;

    const sum=document.createElement('span');
    sum.className='hi-sum';
    sum.textContent=fmtEuro(g.price*g.qty);

    line.append(qty,name,unit,sum);
    items.appendChild(line);
  });

  // Stornierte Positionen getrennt ausweisen, damit die Summe nachvollziehbar ist
  const cancelled=(order.items||[]).filter(it=>it.cancelled);
  if(cancelled.length){
    const grp=new Map();
    cancelled.forEach(it=>{
      const n=productName(it.product_id);
      grp.set(n,(grp.get(n)||0)+1);
    });
    grp.forEach((q,n)=>{
      const line=document.createElement('div');
      line.className='item history-item is-cancelled';
      const qty=document.createElement('span'); qty.className='hi-qty'; qty.textContent=`${q}x`;
      const name=document.createElement('span'); name.className='hi-name'; name.textContent=n;
      const unit=document.createElement('span'); unit.className='hi-unit muted'; unit.textContent='storniert';
      const sum=document.createElement('span'); sum.className='hi-sum'; sum.textContent='—';
      line.append(qty,name,unit,sum);
      items.appendChild(line);
    });
  }
  return items;
}

function renderWaiterHistory(){
  const wrap=$('#orders-history-list');
  if(!wrap) return;
  wrap.innerHTML='';
  const orders=state.waiterHistory||[];
  if(orders.length===0){
    wrap.innerHTML='<div class="muted">Keine Bestellungen vorhanden.</div>';
    return;
  }
  orders.forEach(o=>{
    const card=document.createElement('div');
    card.className='cash-card';

    const row=document.createElement('div');
    row.className='row';

    const left=document.createElement('div');
    const createdDate=toDate(o.created_at);
    const timeStr=createdDate.toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit'});
    const dateStr=createdDate.toLocaleDateString('de-DE',{day:'2-digit',month:'2-digit'});
    left.innerHTML=`<strong>#${o.id}</strong> · <span class="muted">Tisch ${tableDisplayNum(o.table_id)} · ${dateStr} ${timeStr}</span>`;

    const middle=document.createElement('div');
    const badge=document.createElement('span');
    let label='offen', cls='status-open';
    const allItemsPaid=o.items.length>0 && o.items.every(it=>it.paid||it.cancelled);
    if(o.status==='cancelled'){ label='storniert'; cls='status-cancelled'; }
    else if(o.status==='paid'||allItemsPaid){ label='bezahlt'; cls='status-paid'; }
    else if(o.status==='picked'){ label='abgeholt'; cls='status-picked'; }
    else if(o.status==='ready'){ label='bereit'; cls='status-ready'; }
    badge.className=`status-badge ${cls}`;
    badge.textContent=label;
    middle.appendChild(badge);

    const right=document.createElement('div');
    const total=o.items.filter(it=>!it.cancelled).reduce((s,it)=>s+it.price,0);
    right.innerHTML=`<strong>${fmtEuro(total)}</strong>`;

    row.append(left,middle,right);
    card.appendChild(row);

    card.appendChild(buildHistoryItems(o));

    wrap.appendChild(card);
  });
}

/* Admin */
async function adminInit(){ $$('.admin-tabs .tab').forEach(btn=>on(btn,'click',()=>{ $$('.admin-tabs .tab').forEach(b=>b.classList.remove('active')); btn.classList.add('active'); const tab=btn.dataset.tab; $$('.admin-section').forEach(s=>s.classList.add('hidden')); if(tab==='tables'){ $('#admin-tables').classList.remove('hidden'); adminTablesLoad(); } if(tab==='products'){ $('#admin-products').classList.remove('hidden'); adminProductsLoad(); } if(tab==='theken'){ $('#admin-theken').classList.remove('hidden'); adminThekenLoad(); } if(tab==='stations'){ $('#admin-stations').classList.remove('hidden'); adminStationsLoad(); } if(tab==='kategorien'){ $('#admin-kategorien').classList.remove('hidden'); adminKategorienLoad(); } if(tab==='report'){ $('#admin-report').classList.remove('hidden'); adminReportLoad(); } if(tab==='system'){ $('#admin-system').classList.remove('hidden'); adminSystemLoad(); } if(tab==='simulator'){ $('#admin-simulator').classList.remove('hidden'); adminSimulatorOpen(); } else { adminSimulatorClose(); } })); adminTablesLoad(); on('#btn-save-cols','click', adminSaveCols); on('#btn-save-theke-layout','click', adminSaveThekeLayout); on('#btn-apply-tables','click', adminApplyTables); on('#btn-add-product','click', adminAddProduct); on('#btn-add-station','click', adminAddStation); on('#btn-add-theke','click', adminAddTheke); on('#btn-add-kategorie','click', adminAddKategorie); on('#btn-refresh-report','click', adminReportLoad); on('#btn-reset-report','click', adminResetReport); on('#btn-refresh-logs','click', adminSystemLoad); on('#btn-save-pin-bar','click', adminSavePinBar); on('#btn-save-pin-admin','click', adminSavePinAdmin); on('#btn-sim-start','click', simStart); on('#btn-sim-stop','click', simStop); on('#btn-sim-cleanup','click', simCleanup); }
async function adminTablesLoad(){ state.config=await api('/api/config'); $('#cfg-cols').value=state.config.grid_cols??4; $('#cfg-theke-layout').value=(state.config.theke_layout??'badges'); const tables=await api('/api/tables'); $('#tbl-count').textContent=tables.length; $('#tbl-target').value=tables.length; const prev=$('#admin-tables-preview'); prev.innerHTML=''; prev.style.setProperty('--cols', Math.max(3, Math.min(6, +($('#cfg-cols').value||4)))); tables.forEach((t,i)=>{ const b=document.createElement('button'); b.className='table-btn'; b.textContent=i+1; prev.appendChild(b); }); }
async function adminSaveCols(){ const n=Math.max(3,Math.min(6,+($('#cfg-cols').value||4))); await api('/api/config',{method:'PUT', body:JSON.stringify({grid_cols:n})}); state.config.grid_cols=n; await adminTablesLoad(); }
async function adminSaveThekeLayout(){ const v=$('#cfg-theke-layout').value||'badges'; await api('/api/config',{method:'PUT', body:JSON.stringify({theke_layout:v})}); state.config.theke_layout=v; await adminTablesLoad(); }
async function adminApplyTables(){
  const target=Math.max(0,Math.min(500, +($('#tbl-target').value||16)));
  try{
    await api('/api/tables/count',{method:'PUT', body:JSON.stringify({count:target})});
  }catch(e){
    return uiAlert(e.message,{title:'Tische anpassen fehlgeschlagen'});
  }
  await adminTablesLoad();
}
function priceToNumber(s){ if(typeof s==='number') return s; s=(s||'').toString().trim().replace('.','').replace(',','.'); return parseFloat(s)||0; }
// Favoritenfarben fuer Produktkacheln (einzige waehlbare Farben, kein freier Color-Picker)
// Pastellpalette fuer Produktkacheln, nach Farbton sortiert. Gespeichert wird der Hexwert,
// die Reihenfolge darf sich also aendern, ohne dass bestehende Produkte umfaerben.
const FAV_COLORS=[
  {c:'#FCEFB4',n:'Gelb'},{c:'#EBCB8B',n:'Ocker'},{c:'#FFD8B1',n:'Pfirsich'},{c:'#F4A79D',n:'Koralle'},
  {c:'#F6B2B5',n:'Rosa'},{c:'#E5C3E0',n:'Flieder'},{c:'#D4C5E8',n:'Lila'},{c:'#A7C7E7',n:'Blau'},
  {c:'#A8DCD9',n:'Türkis'},{c:'#A8D5BA',n:'Mintgrün'},{c:'#C1E1C1',n:'Hellgrün'},{c:'#DCEBA8',n:'Limette'},
  {c:'#E6DAC3',n:'Sand'},{c:'#C7C7C7',n:'Grau'},{c:'#ffffff',n:'Weiß'}
];
async function adminProductsLoad(){
  state.config=await api('/api/config'); // frisch, damit neue Theken/Kategorien erscheinen
  const list=await api('/api/products');
  state.products=list;
  const stations=(state.config.stations||[]);
  const theken=(state.config.theken||[]);
  const kategorien=(state.config.kategorien||[]);
  const showTheke = theken.length>=2;       // Theke-Spalte nur bei >=2 Theken (Plan 1A)
  const showKat   = kategorien.length>=1;    // Kategorie-Spalte nur wenn >=1 Kategorie
  const tbl=$('#prod-table'); tbl.innerHTML='';

  // Header dynamisch
  let head='<th style="width:78px;">Reihenfolge</th><th>ID</th><th>Name</th><th>Preis</th><th>Farbe</th><th>Station</th>';
  if(showTheke) head+='<th>Theke(n)</th>';
  if(showKat)   head+='<th>Kategorie</th>';
  head+='<th>Aktiv</th><th>1/2</th><th></th>';
  const thead=document.createElement('thead'); thead.innerHTML=`<tr>${head}</tr>`; tbl.appendChild(thead);

  const tb=document.createElement('tbody');
  list.forEach((p,idx)=>{
    const tr=document.createElement('tr'); tr.dataset.id=p.id;
    const color=p.color||'#ffffff';
    const stationOptions=`<option value="">Keine</option>${stations.map(s=>`<option value="${s}" ${p.station===s?'selected':''}>${s}</option>`).join('')}`;
    const colorCell=`<select class="color-select" data-id="${p.id}" data-k="color" style="background-color:${color};color:${contrastColor(color)}">${FAV_COLORS.some(f=>f.c.toLowerCase()===color.toLowerCase())?'':`<option value="${color}" selected>Aktuell</option>`}${FAV_COLORS.map(f=>`<option value="${f.c}" ${color.toLowerCase()===f.c.toLowerCase()?'selected':''}>${f.n}</option>`).join('')}</select>`;

    // Theke-Mehrfachauswahl (leer = alle Theken)
    const sel=Array.isArray(p.theken)?p.theken:[];
    const summary = sel.length ? sel.join(', ') : 'Alle';
    const thekeCell = showTheke ? `<td><details class="theke-multi" data-id="${p.id}"><summary>${summary}</summary><div class="theke-opts">${theken.map(t=>`<label><input type="checkbox" value="${t}" ${sel.includes(t)?'checked':''}/> ${t}</label>`).join('')}</div></details></td>` : '';
    // Kategorie (eine)
    const katCell = showKat ? `<td><select data-id="${p.id}" data-k="kategorie"><option value="">Keine</option>${kategorien.map(k=>`<option value="${k}" ${p.kategorie===k?'selected':''}>${k}</option>`).join('')}</select></td>` : '';

    tr.innerHTML=`<td><button class="btn-up" data-id="${p.id}" ${idx===0?'disabled':''}>▲</button> <button class="btn-down" data-id="${p.id}" ${idx===list.length-1?'disabled':''}>▼</button></td><td>${p.id}</td><td><input data-id="${p.id}" data-k="name" value="${p.name}"/></td><td><input data-id="${p.id}" data-k="price" value="${p.price.toFixed(2).replace('.',',')}"/></td><td>${colorCell}</td><td><select data-id="${p.id}" data-k="station">${stationOptions}</select></td>${thekeCell}${katCell}<td style="text-align:center;"><input type="checkbox" data-id="${p.id}" data-k="active" ${p.active?'checked':''}/></td><td style="text-align:center;"><input type="checkbox" data-id="${p.id}" data-k="half" ${p.half?'checked':''}/></td><td style="text-align:right;"><button class="btn-del" data-id="${p.id}" title="Löschen" aria-label="Löschen">🗑️</button></td>`;
    tb.appendChild(tr);
  });
  tbl.appendChild(tb);

  tb.addEventListener('click', async (e)=>{ const del=e.target.closest('.btn-del'); if(del){ const id=+del.dataset.id; const pname=(state.products.find(p=>p.id===id)||{}).name||('#'+id); if(!await uiConfirm(`"${pname}" wird dauerhaft gelöscht.`,{title:'Produkt löschen?',confirmLabel:'Löschen',destructive:true})) return; await api(`/api/products/${id}`,{method:'DELETE'}); await adminProductsLoad(); return; } const up=e.target.closest('.btn-up'); const down=e.target.closest('.btn-down'); if(!up&&!down) return; const id=+(up?up.dataset.id:down.dataset.id); const row=tb.querySelector(`tr[data-id="${id}"]`); if(up){ const prev=row.previousElementSibling; if(prev) tb.insertBefore(row,prev); } else { const next=row.nextElementSibling; if(next) tb.insertBefore(next,row); } $$('#prod-table tbody tr .btn-up').forEach((b,i)=> b.disabled=(i===0)); const rows=$$('#prod-table tbody tr'); rows.forEach((r,i)=>{ const dn=r.querySelector('.btn-down'); if(dn) dn.disabled=(i===rows.length-1); }); const ids=$$('#prod-table tbody tr').map(tr=>+tr.dataset.id); await api('/api/products/order',{method:'PUT', body:JSON.stringify({order:ids})}); state.products=await api('/api/products'); });
  // Farb-Dropdown: Hintergrund des Selects spiegelt die gewaehlte Farbe
  tb.querySelectorAll('select[data-k="color"]').forEach(sel=>{
    sel.addEventListener('change', ()=>{
      sel.style.backgroundColor = sel.value;
      // Schriftfarbe mitziehen, sonst steht im dunklen Schema heller Text
      // auf einer hellen Produktfarbe
      sel.style.color = contrastColor(sel.value);
    });
  });
  // Theke-Mehrfachauswahl: Summary aktualisieren + speichern
  tb.querySelectorAll('.theke-multi').forEach(det=>{
    det.querySelectorAll('input[type="checkbox"]').forEach(cb=>{
      cb.addEventListener('change', ()=>{
        const id=+det.dataset.id;
        const chosen=Array.from(det.querySelectorAll('input[type="checkbox"]:checked')).map(c=>c.value);
        det.querySelector('summary').textContent = chosen.length ? chosen.join(', ') : 'Alle';
        saveProductRow(id);
      });
    });
  });
  // Sofort-Speichern: jede Aenderung an einem Feld speichert die Zeile direkt
  tb.querySelectorAll('input[data-k], select[data-k]').forEach(el=>{
    el.addEventListener('change', ()=> saveProductRow(+el.dataset.id));
  });
}

// Speichert eine Produktzeile sofort (Einzel-PUT). Aktualisiert state.products lokal.
async function saveProductRow(id){
  const name=$(`input[data-id="${id}"][data-k="name"]`).value.trim();
  const price=priceToNumber($(`input[data-id="${id}"][data-k="price"]`).value);
  const active=$(`input[data-id="${id}"][data-k="active"]`).checked;
  const half=$(`input[data-id="${id}"][data-k="half"]`).checked;
  const color=$(`select[data-id="${id}"][data-k="color"]`)?.value||null;
  const station=$(`select[data-id="${id}"][data-k="station"]`).value||null;
  if(!name || !Number.isFinite(price) || price===0){ return showNotification('Name & Preis erforderlich (Preis ≠ 0, negativ erlaubt)', 'warning'); }
  const body={name,price,active,color,half,station};
  // Theke-Mehrfachauswahl nur senden, wenn die Spalte gerendert ist (sonst unveraendert lassen)
  const thekeBox=$(`.theke-multi[data-id="${id}"]`);
  if(thekeBox) body.theken=Array.from(thekeBox.querySelectorAll('input[type="checkbox"]:checked')).map(c=>c.value);
  const katSel=$(`select[data-id="${id}"][data-k="kategorie"]`);
  if(katSel) body.kategorie=katSel.value||null;
  try{
    await api(`/api/products/${id}`,{method:'PUT', body:JSON.stringify(body)});
    const cur=state.products.find(p=>p.id===id); if(cur) Object.assign(cur,body);
    showNotification('Gespeichert', 'success');
  }catch(e){
    showNotification('Fehler: '+e.message, 'warning');
  }
}

async function adminStationsLoad(){
  state.config=await api('/api/config');
  const stations=state.config.stations||[];
  const list=$('#stations-list');
  list.innerHTML='';

  if(stations.length===0){
    list.innerHTML='<div class="muted">Keine Stationen definiert</div>';
    return;
  }

  stations.forEach(station=>{
    const item=document.createElement('div');
    item.className='station-item';
    item.style.display='flex';
    item.style.justifyContent='space-between';
    item.style.alignItems='center';
    item.style.padding='12px';
    item.style.border='1px solid rgba(0,0,0,.1)';
    item.style.borderRadius='8px';
    item.style.marginBottom='8px';

    const nameDiv=document.createElement('div');
    nameDiv.innerHTML=`<strong>${station}</strong>`;

    const deleteBtn=document.createElement('button');
    deleteBtn.className='outline';
    deleteBtn.textContent='Löschen';
    deleteBtn.addEventListener('click',async ()=>{
      if(!await uiConfirm(`Die Station "${station}" wird entfernt. Zugeordnete Produkte bleiben erhalten.`,{title:'Station löschen?',confirmLabel:'Löschen',destructive:true})) return;
      const newStations=stations.filter(s=>s!==station);
      await api('/api/config',{method:'PUT', body:JSON.stringify({stations:newStations})});
      await adminStationsLoad();
    });

    item.append(nameDiv,deleteBtn);
    list.appendChild(item);
  });
}

async function adminAddStation(){
  const name=$('#station-new-name').value.trim();
  if(!name) return uiAlert('Bitte gib einen Namen für die Station ein.',{title:'Name fehlt'});

  state.config=await api('/api/config');
  const stations=state.config.stations||[];

  if(stations.includes(name)){
    return uiAlert('Eine Station mit diesem Namen gibt es schon.',{title:'Name schon vergeben'});
  }

  stations.push(name);
  await api('/api/config',{method:'PUT', body:JSON.stringify({stations})});
  $('#station-new-name').value='';
  await adminStationsLoad();
}

// Generische Verwaltung von config-Listen (Theken, Kategorien) - analog Stationen
async function adminConfigListLoad(configKey, listSel, labelSing){
  state.config=await api('/api/config');
  const items=state.config[configKey]||[];
  const list=$(listSel);
  list.innerHTML='';
  if(items.length===0){ list.innerHTML=`<div class="muted">Keine ${labelSing} definiert</div>`; return; }
  items.forEach(name=>{
    const item=document.createElement('div');
    item.className='station-item';
    item.style.cssText='display:flex;justify-content:space-between;align-items:center;padding:12px;border:1px solid rgba(0,0,0,.1);border-radius:8px;margin-bottom:8px';
    const nameDiv=document.createElement('div'); nameDiv.innerHTML=`<strong>${name}</strong>`;
    const del=document.createElement('button'); del.className='outline'; del.textContent='Löschen';
    del.addEventListener('click', async ()=>{
      if(!await uiConfirm(`"${name}" wird entfernt.`,{title:`${labelSing} löschen?`,confirmLabel:'Löschen',destructive:true})) return;
      const next=items.filter(s=>s!==name);
      await api('/api/config',{method:'PUT', body:JSON.stringify({[configKey]:next})});
      await adminConfigListLoad(configKey, listSel, labelSing);
    });
    item.append(nameDiv,del);
    list.appendChild(item);
  });
}
async function adminConfigListAdd(configKey, inputSel, listSel, labelSing){
  const name=$(inputSel).value.trim();
  if(!name) return uiAlert(`Bitte gib einen Namen für die ${labelSing} ein.`,{title:'Name fehlt'});
  state.config=await api('/api/config');
  const items=state.config[configKey]||[];
  if(items.includes(name)) return uiAlert(`"${name}" gibt es schon.`,{title:'Name schon vergeben'});
  items.push(name);
  await api('/api/config',{method:'PUT', body:JSON.stringify({[configKey]:items})});
  $(inputSel).value='';
  await adminConfigListLoad(configKey, listSel, labelSing);
}
async function adminThekenLoad(){ return adminConfigListLoad('theken','#theken-list','Theke'); }
async function adminAddTheke(){ return adminConfigListAdd('theken','#theke-new-name','#theken-list','Theke'); }
async function adminKategorienLoad(){ return adminConfigListLoad('kategorien','#kategorien-list','Kategorie'); }
async function adminAddKategorie(){ return adminConfigListAdd('kategorien','#kategorie-new-name','#kategorien-list','Kategorie'); }

async function adminAddProduct(){ const name=$('#p-new-name').value.trim(); const price=priceToNumber($('#p-new-price').value); const color=$('#p-new-color').value||null; if(!name || !Number.isFinite(price) || price===0) return uiAlert('Name und Preis sind erforderlich. Der Preis darf nicht null sein, negative Werte sind erlaubt.',{title:'Angaben unvollständig'}); await api('/api/products',{method:'POST', body:JSON.stringify({name,price,color})}); $('#p-new-name').value=''; $('#p-new-price').value=''; $('#p-new-color').value='#ffffff'; await adminProductsLoad(); }
async function adminReportLoad(){ const rep=await api('/api/report/summary'); $('#rep-total').textContent=fmtEuro(rep.total); const tbl=$('#rep-table'); tbl.innerHTML=''; const thead=document.createElement('thead'); thead.innerHTML='<tr><th>Produkt</th><th>Anzahl</th></tr>'; tbl.appendChild(thead); const tb=document.createElement('tbody'); (rep.products||[]).forEach(r=>{ const tr=document.createElement('tr'); tr.innerHTML=`<td>${r.name}</td><td>${r.qty}</td>`; tb.appendChild(tr); }); tbl.appendChild(tb); }
async function adminResetReport(){ if(!await uiConfirm('Alle Bestellungen und Positionen werden dauerhaft gelöscht. Das lässt sich nicht rückgängig machen.',{title:'Auswertung zurücksetzen?',confirmLabel:'Alles löschen',destructive:true})) return; await api('/api/report/reset',{method:'POST'}); await adminReportLoad(); }

async function adminSavePinBar() {
  const newPin = $('#pin-bar-input').value.trim();
  if (!newPin) {
    return uiAlert('Bitte gib die neue PIN ein.',{title:'PIN fehlt'});
  }
  if (!/^\d{4,8}$/.test(newPin)) {
    return uiAlert('Die PIN muss aus vier bis acht Ziffern bestehen.',{title:'PIN ungültig'});
  }
  try {
    await api('/api/settings/pins', {
      method: 'PUT',
      body: JSON.stringify({ pin_bar: newPin })
    });
    showNotification('Theke-PIN geändert','success');
    $('#pin-bar-input').value = '';
    await adminSystemLoad();
  } catch (e) {
    uiAlert(e.message,{title:'PIN ändern fehlgeschlagen'});
  }
}

async function adminSavePinAdmin() {
  const newPin = $('#pin-admin-input').value.trim();
  if (!newPin) {
    return uiAlert('Bitte gib die neue PIN ein.',{title:'PIN fehlt'});
  }
  if (!/^\d{4,8}$/.test(newPin)) {
    return uiAlert('Die PIN muss aus vier bis acht Ziffern bestehen.',{title:'PIN ungültig'});
  }
  try {
    await api('/api/settings/pins', {
      method: 'PUT',
      body: JSON.stringify({ pin_admin: newPin })
    });
    showNotification('Admin-PIN geändert','success');
    $('#pin-admin-input').value = '';
    await adminSystemLoad();
  } catch (e) {
    uiAlert(e.message,{title:'PIN ändern fehlgeschlagen'});
  }
}

// === Simulator-Steuerung (Admin-Tab) ===
const simBrowser = { active:false, loops:[], idCounter:0 };
let simPollTimer = null;

function simReadConfig(){
  return {
    waiters:          +$('#sim-waiters').value || 5,
    durationMin:      +$('#sim-duration').value || 0,
    orderIntervalMin: +$('#sim-int-min').value || 20,
    orderIntervalMax: +$('#sim-int-max').value || 60,
    itemsMin:         +$('#sim-items-min').value || 1,
    itemsMax:         +$('#sim-items-max').value || 6,
    thekeMin:         +$('#sim-theke-min').value || 15,
    thekeMax:         +$('#sim-theke-max').value || 45,
    pickupMin:        +$('#sim-pick-min').value || 5,
    pickupMax:        +$('#sim-pick-max').value || 20,
    payFull:          +$('#sim-pay-full').value || 60,
    payPartial:       +$('#sim-pay-partial').value || 30,
    cancelRate:       +$('#sim-cancel').value || 5,
    posRatio:         +$('#sim-pos').value || 0,
  };
}

async function simStart(){
  const cfg = simReadConfig();
  if(cfg.orderIntervalMin >= cfg.orderIntervalMax) return uiAlert('Beim Order-Intervall muss der Minimalwert kleiner als der Maximalwert sein.',{title:'Konfiguration prüfen'});
  if(cfg.itemsMin > cfg.itemsMax) return uiAlert('Bei den Items pro Order ist der Minimalwert größer als der Maximalwert.',{title:'Konfiguration prüfen'});
  if(cfg.payFull + cfg.payPartial > 100) return uiAlert('Voll- und Teilzahlung ergeben zusammen mehr als hundert Prozent.',{title:'Konfiguration prüfen'});
  try {
    await api('/api/simulator/start', { method:'POST', body: JSON.stringify(cfg) });
    if($('#sim-browser-mode').checked) simBrowserStart(cfg, +$('#sim-browser-count').value||3);
    $('#btn-sim-start').disabled = true;
    $('#btn-sim-stop').disabled  = false;
    $('#sim-running-badge').classList.remove('hidden');
    simStartPolling();
  } catch(e){ uiAlert(e.message,{title:'Simulator-Start fehlgeschlagen'}); }
}

async function simStop(){
  try { await api('/api/simulator/stop', { method:'POST' }); } catch(e){}
  simBrowserStop();
  $('#btn-sim-start').disabled = false;
  $('#btn-sim-stop').disabled  = true;
  $('#sim-running-badge').classList.add('hidden');
  await simPollOnce();
}

async function simCleanup(){
  if(!await uiConfirm('Alle Einträge mit dem Präfix SIM_ werden entfernt.',{title:'Simulator-Daten löschen?',confirmLabel:'Löschen',destructive:true})) return;
  try {
    const r = await api('/api/simulator/cleanup', { method:'POST' });
    showNotification(`Cleanup fertig: ${r.ordersRemoved} Orders entfernt`,'success');
    await simPollOnce();
  } catch(e){ uiAlert(e.message,{title:'Cleanup fehlgeschlagen'}); }
}

function adminSimulatorOpen(){ simPollOnce(); simStartPolling(); }
function adminSimulatorClose(){ if(simPollTimer){ clearInterval(simPollTimer); simPollTimer=null; } }

function simStartPolling(){
  if(simPollTimer) return;
  simPollTimer = setInterval(simPollOnce, 1500);
}

async function simPollOnce(){
  try {
    const st = await api('/api/simulator/status');
    const target = $('#sim-status');
    if(!target) return;
    const s = st.stats || {};
    const mins = Math.floor(st.uptimeSec/60), secs = st.uptimeSec%60;
    const opm = st.uptimeSec>0 ? (s.ordersCreated/(st.uptimeSec/60)).toFixed(1) : '–';
    const rows = [
      ['Status',            st.running ? '<span style="color:#16a34a;font-weight:700;">▶ aktiv</span>' : '<span class="muted">gestoppt</span>'],
      ['Laufzeit',          st.running ? `${mins}m ${secs}s` : '–'],
      ['Virtuelle Bediener',st.activeWaiters||0],
      ['Browser-Clients',   simBrowser.active ? simBrowser.loops.length : 0],
      ['Orders erzeugt',    `${s.ordersCreated||0}  (${opm}/min)`],
      ['Items erzeugt',     s.itemsCreated||0],
      ['Items ready',       s.itemsReady||0],
      ['Items picked',      s.itemsPicked||0],
      ['Items kassiert',    s.itemsPaid||0],
      ['Items storniert',   s.itemsCancelled||0],
      ['Orders kassiert',   s.ordersPaid||0],
      ['Fehler',            (s.errors||0) > 0 ? `<span style="color:#dc2626;font-weight:700;">${s.errors}</span>` : '0'],
    ];
    target.innerHTML = rows.map(([k,v])=>`<div class="stat-row"><span class="muted">${k}:</span><strong>${v}</strong></div>`).join('');

    // Buttons anhand State setzen
    $('#btn-sim-start').disabled = st.running;
    $('#btn-sim-stop').disabled  = !st.running;
    $('#sim-running-badge').classList.toggle('hidden', !st.running);

    // Auto-stop des Browser-Modus, falls Server gestoppt hat (z.B. durch durationMin-Timeout)
    if(!st.running && simBrowser.active) simBrowserStop();
  } catch(e){ /* still */ }
}

// === Browser-Modus (Option B): zusaetzliche HTTP-Last aus dem Admin-Tab ===
function simBrowserStart(cfg, count){
  simBrowser.active = true;
  for(let i=0; i<count; i++){
    const id = ++simBrowser.idCounter;
    const ls = { id, active:true };
    simBrowser.loops.push(ls);
    simBrowserLoop(ls, cfg);
  }
}

async function simBrowserLoop(ls, cfg){
  // Produkte und Tische einmalig laden
  const [products, tables] = await Promise.all([api('/api/products'), api('/api/tables')]);
  const activeProducts = products.filter(p=>p.active);
  const realTables = tables.filter(t=>t.name!=='POS');
  while(ls.active && simBrowser.active){
    try {
      const n = Math.floor(cfg.itemsMin + Math.random()*(cfg.itemsMax-cfg.itemsMin+1));
      const items = [];
      for(let i=0;i<n;i++) items.push(activeProducts[Math.floor(Math.random()*activeProducts.length)].id);
      const table = realTables[Math.floor(Math.random()*realTables.length)];
      await api('/api/orders', { method:'POST', body: JSON.stringify({
        table_id: table.id,
        waiter: `SIM_Browser_${ls.id}`,
        items
      })});
    } catch(e){ /* still */ }
    const wait = (cfg.orderIntervalMin + Math.random()*(cfg.orderIntervalMax-cfg.orderIntervalMin)) * 1000;
    await new Promise(r=>setTimeout(r, wait));
  }
}

function simBrowserStop(){
  simBrowser.active = false;
  simBrowser.loops.forEach(l => { l.active = false; });
  simBrowser.loops = [];
}

async function adminSystemLoad(){
  // Load current PINs (masked)
  try {
    const pins = await api('/api/settings/pins');
    $('#pin-bar-input').placeholder = pins.pin_bar;
    $('#pin-admin-input').placeholder = pins.pin_admin;
  } catch (e) {
    console.error('Failed to load PINs:', e);
  }

  // Fetch system status
  const status=await api('/api/system/status');
  const statusDiv=$('#system-status');
  statusDiv.innerHTML='';

  // Format uptime
  const uptime=Math.floor(status.uptime);
  const hours=Math.floor(uptime/3600);
  const mins=Math.floor((uptime%3600)/60);
  const secs=uptime%60;
  const uptimeStr=`${hours}h ${mins}m ${secs}s`;

  // Format Host-Metriken (CPU/RAM/Temp/Disk/Pi-Throttling/Node/EventLoop/HTTP/Network/WLAN)
  const formatBytes=(b)=>{
    if(b>=1024**3) return (b/1024**3).toFixed(2)+' GB';
    if(b>=1024**2) return (b/1024**2).toFixed(1)+' MB';
    return Math.round(b/1024)+' KB';
  };
  const formatRate=(bps)=>{
    if(bps>=1024**2) return (bps/1024**2).toFixed(2)+' MB/s';
    if(bps>=1024)    return (bps/1024).toFixed(1)+' KB/s';
    return bps+' B/s';
  };
  // Ampel-Klassifizierer pro Metrik (ok/warn/crit)
  const classify=(type,value)=>{
    switch(type){
      case 'percent_load': return value<50 ? 'ok' : value<80 ? 'warn' : 'crit';
      case 'percent_ram':  return value<70 ? 'ok' : value<85 ? 'warn' : 'crit';
      case 'temp':         return value<70 ? 'ok' : value<80 ? 'warn' : 'crit';
      case 'percent_disk': return value<70 ? 'ok' : value<85 ? 'warn' : 'crit';
      case 'throttling': {
        if(!value.ok) return 'crit';
        const everSeen = value.undervoltageEver||value.armFreqCappedEver||value.throttledEver||value.tempLimitEver;
        return everSeen ? 'warn' : 'ok';
      }
      case 'db_mb':        return value<100 ? 'ok' : value<500 ? 'warn' : 'crit';
      case 'heap_percent': return value<70 ? 'ok' : value<90 ? 'warn' : 'crit';
      case 'eventloop_ms': return value<50 ? 'ok' : value<200 ? 'warn' : 'crit';
      case 'http_errors':  return value===0 ? 'ok' : value<=10 ? 'warn' : 'crit';
      case 'fds':          return value<500 ? 'ok' : value<900 ? 'warn' : 'crit';
      case 'wlan_dbm':     return value>-60 ? 'ok' : value>-75 ? 'warn' : 'crit';
    }
    return null;
  };
  const h=status.host||{};
  const hostMetrics=[];
  if(h.hostname) hostMetrics.push({label:'Host', value:`${h.hostname} (${h.platform})`});
  if(h.loadAvg) hostMetrics.push({label:'CPU-Last', value:`${h.loadPercent}% (${h.loadAvg.map(v=>v.toFixed(2)).join(' / ')}) · ${h.cpuCount} Kerne`, status:classify('percent_load', h.loadPercent)});
  if(h.memTotal) hostMetrics.push({label:'RAM', value:`${formatBytes(h.memUsed)} / ${formatBytes(h.memTotal)} (${h.memPercent}%)`, status:classify('percent_ram', h.memPercent)});
  if(h.cpuTemp!=null) hostMetrics.push({label:'CPU-Temp', value:`${h.cpuTemp.toFixed(1)} °C`, status:classify('temp', h.cpuTemp)});
  if(h.disk) hostMetrics.push({label:'Disk', value:`${formatBytes(h.disk.used)} / ${formatBytes(h.disk.total)} (${h.disk.percent}%)`, status:classify('percent_disk', h.disk.percent)});
  if(h.throttling){
    const t=h.throttling;
    const flags=[];
    if(t.undervoltageNow)   flags.push('Unterspannung');
    if(t.armFreqCappedNow)  flags.push('CPU-Cap aktiv');
    if(t.throttledNow)      flags.push('Throttling aktiv');
    if(t.tempLimitNow)      flags.push('Temp-Limit aktiv');
    const everFlags=[];
    if(t.undervoltageEver)  everFlags.push('Unterspannung');
    if(t.armFreqCappedEver) everFlags.push('CPU-Cap');
    if(t.throttledEver)     everFlags.push('Throttling');
    if(t.tempLimitEver)     everFlags.push('Temp-Limit');
    let v = t.ok ? 'OK' : flags.join(', ')||'aktiv';
    if(everFlags.length) v += ` · seit Boot: ${everFlags.join(', ')}`;
    hostMetrics.push({label:'Pi-Throttling', value:v, status:classify('throttling', t)});
  }
  if(h.dbSize!=null) hostMetrics.push({label:'DB-Größe', value:formatBytes(h.dbSize), status:classify('db_mb', h.dbSize/1024**2)});
  if(h.nodeProcess){
    const n=h.nodeProcess;
    const heapPct = Math.round((n.heapUsed / n.heapTotal) * 100);
    hostMetrics.push({label:'Node Heap', value:`${formatBytes(n.heapUsed)} / ${formatBytes(n.heapTotal)} (${heapPct}%) · RSS ${formatBytes(n.rss)}`, status:classify('heap_percent', heapPct)});
  }
  if(h.eventLoop){
    const e=h.eventLoop;
    hostMetrics.push({label:'Event-Loop-Lag', value:`p50 ${e.p50}ms · p95 ${e.p95}ms · p99 ${e.p99}ms · max ${e.max}ms`, status:classify('eventloop_ms', e.p95)});
  }
  if(h.httpErrors){
    const e=h.httpErrors;
    const v = e.last60s===0 ? 'keine' : `${e.last60s} (4xx: ${e.errors4xx} · 5xx: ${e.errors5xx})`;
    hostMetrics.push({label:'HTTP-Fehler (60s)', value:v, status:classify('http_errors', e.last60s)});
  }
  if(h.openFds!=null) hostMetrics.push({label:'Open FDs', value:h.openFds, status:classify('fds', h.openFds)});
  if(h.network && h.network.ratesPerSec){
    Object.entries(h.network.ratesPerSec).forEach(([iface,r])=>{
      hostMetrics.push({label:`Netz ${iface}`, value:`↓ ${formatRate(r.rxBps)} · ↑ ${formatRate(r.txBps)}`});
    });
  }
  if(h.wlanStations && h.wlanStations.length){
    h.wlanStations.forEach(s=>{
      hostMetrics.push({label:`WLAN ${s.mac}`, value:`${s.signalDbm} dBm · RX ${s.rxMbps||'?'} Mbps · TX ${s.txMbps||'?'} Mbps`, status:classify('wlan_dbm', s.signalDbm)});
    });
  }

  // Render status metrics
  const metrics=[
    ...hostMetrics,
    ...(hostMetrics.length ? [{label:'', value:'', separator:true}] : []),
    {label:'Uptime', value:uptimeStr},
    {label:'Offene Bestellungen', value:status.orders.open},
    {label:'Bestellpositionen (Gesamt)', value:status.orders.itemsTotal},
    {label:'Angemeldete Bediener', value:status.sessions},
    {label:'Aktive Produkte', value:status.products},
    {label:'Log-Einträge', value:status.logEntries}
  ];

  // Add WebSocket statistics if available
  if(status.websocket){
    const wsUptime=`${Math.floor(status.websocket.uptime/3600)}h ${Math.floor((status.websocket.uptime%3600)/60)}m`;
    metrics.push(
      {label:'', value:'', separator:true},
      {label:'WebSocket Clients', value:status.websocket.connectedClients},
      {label:'WS Verbindungen (Total)', value:status.websocket.totalConnections},
      {label:'WS Nachrichten (Sent)', value:status.websocket.messagesSent},
      {label:'WS Nachrichten (Received)', value:status.websocket.messagesReceived},
      {label:'WS Uptime', value:wsUptime}
    );

    // Add broadcast events
    const events=Object.entries(status.websocket.broadcastEvents||{});
    if(events.length>0){
      metrics.push({label:'', value:'', separator:true});
      events.forEach(([event,count])=>{
        metrics.push({label:`Event: ${event}`, value:count});
      });
    }
  }

  metrics.forEach(m=>{
    if(m.separator){
      const sep=document.createElement('div');
      sep.style.height='1px';
      sep.style.background='rgba(0,0,0,.1)';
      sep.style.margin='12px 0';
      statusDiv.appendChild(sep);
      return;
    }

    const item=document.createElement('div');
    item.style.display='flex';
    item.style.justifyContent='space-between';
    item.style.padding='8px 0';
    item.style.borderBottom='1px solid rgba(0,0,0,.05)';
    const dot = m.status ? `<span class="ampel-dot ampel-${m.status}" title="${m.status==='ok'?'OK':m.status==='warn'?'Warnung':'Kritisch'}"></span>` : '';
    item.innerHTML=`<span class="muted">${m.label}:</span><strong>${dot}${m.value}</strong>`;
    statusDiv.appendChild(item);
  });

  // Render connected clients
  renderSystemClients(status.clients||[]);

  // Fetch and render logs
  const logs=await api('/api/system/logs');
  const logsDiv=$('#system-logs');
  logsDiv.innerHTML='';

  if(logs.length===0){
    logsDiv.innerHTML='<div class="muted">Keine Logs vorhanden</div>';
    return;
  }

  logs.forEach(entry=>{
    const item=document.createElement('div');
    item.style.padding='8px';
    item.style.marginBottom='4px';
    item.style.borderRadius='4px';
    item.style.fontSize='12px';
    item.style.fontFamily='monospace';
    item.style.borderLeft='3px solid';

    // Color-code by level
    let bgColor='rgba(0,0,0,.02)';
    let borderColor='#888';
    if(entry.level==='warning'){
      bgColor='rgba(255,165,0,.1)';
      borderColor='orange';
    } else if(entry.level==='error'){
      bgColor='rgba(255,0,0,.1)';
      borderColor='red';
    } else if(entry.level==='info'){
      borderColor='#0a84ff';
    }

    item.style.backgroundColor=bgColor;
    item.style.borderLeftColor=borderColor;

    // Format timestamp
    const ts=new Date(entry.timestamp);
    const time=ts.toLocaleTimeString('de-DE');

    // Build content
    let content=`<div style="margin-bottom:4px;"><strong style="color:${borderColor};">[${entry.level.toUpperCase()}]</strong> <span class="muted">${time}</span> <strong>${entry.category}</strong></div>`;
    content+=`<div>${entry.message}</div>`;

    if(entry.data){
      content+=`<div class="muted" style="margin-top:4px;font-size:11px;">${JSON.stringify(entry.data)}</div>`;
    }

    item.innerHTML=content;
    logsDiv.appendChild(item);
  });
}

function shortUA(ua){
  if(!ua) return '—';
  if(/iPad/i.test(ua)) return 'iPad / Safari';
  if(/iPhone/i.test(ua)) return 'iPhone / Safari';
  if(/Android/i.test(ua)) return 'Android';
  if(/Edg\//.test(ua)) return 'Edge';
  if(/Chrome\//.test(ua)) return 'Chrome';
  if(/Firefox\//.test(ua)) return 'Firefox';
  if(/Safari\//.test(ua)) return 'Safari';
  return ua.slice(0,40);
}

function renderSystemClients(clients){
  const wrap=$('#system-clients');
  if(!wrap) return;
  wrap.innerHTML='';
  if(!clients.length){
    wrap.innerHTML='<div class="muted">Keine Clients verbunden</div>';
    return;
  }
  const table=document.createElement('table');
  table.className='prod-table';
  table.innerHTML='<thead><tr><th>Rolle/User</th><th>Viewport</th><th>Orient.</th><th>DPR</th><th>PWA</th><th>Device</th><th>IP</th><th>seit</th></tr></thead>';
  const tb=document.createElement('tbody');
  clients.forEach(c=>{
    const tr=document.createElement('tr');
    const roleUser=c.role?`${c.role}${c.user?` · ${c.user}`:''}`:'—';
    const vp=c.viewport?`${c.viewport.w}×${c.viewport.h}`:'—';
    const orient=c.orientation||'—';
    const dpr=c.dpr?c.dpr+'x':'—';
    const pwa=c.standalone===true?'✓':(c.standalone===false?'—':'?');
    const dev=shortUA(c.userAgent);
    const ip=(c.ip||'').replace('::ffff:','');
    let seit='—';
    if(c.connectedAt){
      const diffSec=Math.floor((Date.now()-new Date(c.connectedAt).getTime())/1000);
      if(diffSec<60) seit=diffSec+'s';
      else if(diffSec<3600) seit=Math.floor(diffSec/60)+'m';
      else seit=Math.floor(diffSec/3600)+'h '+Math.floor((diffSec%3600)/60)+'m';
    }
    tr.innerHTML=`<td><strong>${roleUser}</strong></td><td>${vp}</td><td>${orient}</td><td>${dpr}</td><td style="text-align:center;">${pwa}</td><td>${dev}</td><td><span class="muted">${ip}</span></td><td>${seit}</td>`;
    tb.appendChild(tr);
  });
  table.appendChild(tb);
  wrap.appendChild(table);
}

// Polling Fallback: Only polls if WebSocket is not connected
async function pollOrders(){
  setInterval(async ()=>{
    try{
      // Only poll if WebSocket is not connected (Fallback mode)
      const wsConnected = state.ws && state.ws.readyState === WebSocket.OPEN;

      if (!wsConnected) {
        console.log('[Polling] WebSocket offline, using polling fallback...');

        const active=['#view-theke','#view-tables','#view-products','#view-admin'];
        if(active.some(v=>!$(v).classList.contains('hidden'))){
          state.orders=await api('/api/orders');
          state.sessions=await api('/api/sessions');
          state.products=await api('/api/products');

          // Check if waiter session still exists
          if(state.role==='waiter' && state.user){
            const mySession=state.sessions.find(s=>s.waiter===state.user);
            if(!mySession){
              showNotification('Du wurdest von der Theke abgemeldet','warning');
              releaseWakeLock();
              await stopHeartbeat();
              disconnectWebSocket();
              location.reload();
              return;
            }
          }

          // Re-render views
          renderActiveView();
        }
      }
    }catch(err){
      console.error('[Polling] Error:', err);
    }
  }, 30000); // 30 seconds (was 1000ms = 1s)
}

$('#app-header').classList.add('hidden');
show('#view-login');
// Verbindungsanzeige schon auf der Login-Seite aktivieren
startLoginHealthCheck();

// Das Alter der Bestellungen läuft weiter, auch wenn an der Theke kein Event
// passiert (lange Zubereitung). 30 s: die Anzeige hat Minutenauflösung, damit
// ist sie nie mehr als eine halbe Minute daneben.
setInterval(refreshAges, 30000);

// iOS PWA + Desktop: readonly bei pointerdown entfernen (deckt Touch und Maus ab)
['#inp-name','#inp-pin'].forEach(sel=>{
  const el=$(sel);
  if(!el) return;
  el.addEventListener('pointerdown',()=>el.removeAttribute('readonly'),{passive:true});
});

// Wake Lock und WebSocket bei Sichtbarkeitswechsel reaktivieren (iOS Standby-Wakeup)
document.addEventListener('visibilitychange', async ()=>{
  if(!document.hidden && state.user){
    // iOS friert Timer im Hintergrund ein - Alter sofort korrigieren, statt
    // bis zu 30 s lang veraltete Zahlen zu zeigen
    refreshAges();
    if(!state.wakeLock) await requestWakeLock();
    // iOS-Zombie-Schutz: readyState kann faelschlich OPEN melden obwohl die
    // Verbindung nach Standby tot ist (verpasste Broadcasts). Daher beim
    // Sichtbarwerden IMMER hart neu verbinden -> frisches init synct den State.
    console.log('[WebSocket] Visibility restored – forcing WS resync');
    forceReconnectWebSocket();
  }
});

// Sofortiger Reconnect wenn Netzwerk wieder verfügbar (z.B. nach WLAN-Trennung)
window.addEventListener('online', () => {
  if(state.user && (!state.ws || state.ws.readyState !== WebSocket.OPEN)){
    console.log('[WebSocket] Network online – reconnecting immediately');
    connectWebSocket();
  }
});

// Viewport/Orientation-Änderungen an Server melden (debounced) + POS-Grid neu layouten
let _clientInfoResizeTimer = null;
let _posLayoutResizeTimer = null;
window.addEventListener('resize', () => {
  if (_posLayoutResizeTimer) clearTimeout(_posLayoutResizeTimer);
  _posLayoutResizeTimer = setTimeout(layoutPOSGrid, 80);
  if (_clientInfoResizeTimer) clearTimeout(_clientInfoResizeTimer);
  _clientInfoResizeTimer = setTimeout(sendClientInfo, 500);
});
window.addEventListener('orientationchange', () => {
  setTimeout(() => { layoutPOSGrid(); sendClientInfo(); }, 250);
});

// =============================================================================
// iOS/iPad PWA: Scroll-Fixes für Theke
// =============================================================================

// Touchmove Prevention: Verhindert Body-Scroll wenn lock-scroll aktiv
document.addEventListener('touchmove', (e) => {
  if (!document.body.classList.contains('lock-scroll')) return;

  // Scroll erlauben nur innerhalb der Spalten
  const scroller = e.target.closest('.theke-col, .bediener-column, .pos-column, .pos-products-area, .station-mode-grid .grid.products');
  if (scroller) return;

  e.preventDefault();
}, { passive: false });

// iOS Scroll-Containment: Verhindert "bounce-through" am Ende der Spalte
function iosContainScroll(el) {
  el.addEventListener('touchstart', () => {
    // Am oberen Ende: Setze scroll leicht nach unten
    if (el.scrollTop === 0) {
      el.scrollTop = 1;
    }
    // Am unteren Ende: Setze scroll leicht nach oben
    if (el.scrollTop + el.clientHeight >= el.scrollHeight) {
      el.scrollTop = el.scrollHeight - el.clientHeight - 1;
    }
  }, { passive: true });
}

// Fixes auf alle Theke-Spalten anwenden
let scrollFixesApplied = false;
function applyThekeScrollFixes() {
  if (scrollFixesApplied) return; // Nur einmal pro Render

  // Alle scrollbaren Bereiche finden
  const scrollers = $$('.theke-col, .bediener-column, .pos-products-area');
  scrollers.forEach(iosContainScroll);

  scrollFixesApplied = true;
  setTimeout(() => scrollFixesApplied = false, 100);

  console.log('[iOS] Scroll fixes applied to', scrollers.length, 'elements');
}