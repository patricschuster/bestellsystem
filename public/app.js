// app.js (v2.4.1 + POS)
const $  = (s)=>document.querySelector(s);
const $$ = (s)=>Array.from(document.querySelectorAll(s));
const on = (sel,evt,fn)=>{ const el=(typeof sel==='string')?$(sel):sel; if(el) el.addEventListener(evt,fn); };

const state={ role:'waiter', user:null, tables:[], products:[], orders:[], config:{}, version:'2.6', posMode:false, posBasket:new Map(), sessions:[], heartbeatInterval:null, wakeLock:null, favorites:new Set(), favoritesFilterActive:false, selectedStation:null, ws:null, wsReconnectAttempts:0, connectionStatus:'offline', wsPingInterval:null, loginHealthCheckInterval:null };

async function api(path, opts={}){ const res=await fetch(path,{ headers:{'Content-Type':'application/json'}, ...opts }); if(!res.ok){ let t=await res.text(); try{ const j=JSON.parse(t); t=j.error||j.message||t; }catch{}; throw new Error(t); } return res.json(); }

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

      // Send initial ping
      if (state.ws.readyState === WebSocket.OPEN) {
        state.ws.send(JSON.stringify({ event: 'ping', timestamp: new Date().toISOString() }));
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
      state.orders.push(data);

      // Only re-render if relevant views are active
      if (!$('#view-theke').classList.contains('hidden')) {
        renderTheke();
      }
      if (!$('#view-tables').classList.contains('hidden')) {
        renderTables();
      }
      if (!$('#view-cash').classList.contains('hidden')) {
        renderCash();
      }

      // Play notification sound (optional)
      playNotificationSound();
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
      break;

    case 'order:paid':
      // Order was paid, remove from list
      console.log('[WebSocket] Order paid:', data.id);
      state.orders = state.orders.filter(o => o.id !== data.id);
      renderActiveView();
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

// Helper: Render active view
function renderActiveView() {
  if (!$('#view-tables').classList.contains('hidden')) renderTables();
  if (!$('#view-theke').classList.contains('hidden')) renderTheke();
  if (!$('#view-cash').classList.contains('hidden')) renderCash();
  if (!$('#view-cash-detail').classList.contains('hidden') && currentCashOrder) openCashDetail(currentCashOrder.id);
  if (!$('#view-products').classList.contains('hidden')) renderProducts();
}

// Helper: Play notification sound (optional)
function playNotificationSound() {
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
  const comment=$('#comment-text').value.trim()||null;
  const basketItem=basket.get(currentCommentProduct.id);
  if(!basketItem){
    basket.set(currentCommentProduct.id,{items:[{comment}]});
  } else {
    basketItem.items.push({comment});
  }
  closeCommentDialog();
  renderProducts();
}

/* Station Selection */
function openStationSelect(){ renderStationSelect(); $('#station-select-modal').classList.remove('hidden'); }
function closeStationSelect(){ $('#station-select-modal').classList.add('hidden'); }
function renderStationSelect(){
  const list=$('#station-select-list');
  list.innerHTML='';

  const stations=state.config.stations||[];

  // Prüfen ob es überhaupt Produkte mit Stationen gibt
  const productsWithStations=state.products.filter(p=>p.station);
  if(productsWithStations.length===0){
    list.innerHTML='<div class="muted text-center">Keine Stationen konfiguriert oder keine Produkte einer Station zugeordnet.</div>';
    return;
  }

  // "Alle Bestellungen" Option
  const allItem=document.createElement('div');
  allItem.className='station-select-item';
  allItem.style.padding='16px';
  allItem.style.border='2px solid '+(state.selectedStation===null?'#0a84ff':'rgba(0,0,0,.1)');
  allItem.style.borderRadius='8px';
  allItem.style.marginBottom='12px';
  allItem.style.cursor='pointer';
  allItem.style.backgroundColor=state.selectedStation===null?'rgba(10,132,255,.05)':'transparent';
  allItem.innerHTML='<strong>Alle Bestellungen</strong><div class="muted">Normale Thekenansicht</div>';
  allItem.addEventListener('click',()=>{
    state.selectedStation=null;
    closeStationSelect();
    renderTheke();
    updateHeader('#view-theke');
  });
  list.appendChild(allItem);

  // Stations-Optionen
  stations.forEach(station=>{
    // Nur Stationen anzeigen, die auch Produkte haben
    const hasProducts=state.products.some(p=>p.station===station);
    if(!hasProducts) return;

    const item=document.createElement('div');
    item.className='station-select-item';
    item.style.padding='16px';
    item.style.border='2px solid '+(state.selectedStation===station?'#0a84ff':'rgba(0,0,0,.1)');
    item.style.borderRadius='8px';
    item.style.marginBottom='12px';
    item.style.cursor='pointer';
    item.style.backgroundColor=state.selectedStation===station?'rgba(10,132,255,.05)':'transparent';

    const productsInStation=state.products.filter(p=>p.station===station);
    item.innerHTML=`<strong>${station}</strong><div class="muted">${productsInStation.length} Produkt${productsInStation.length!==1?'e':''}</div>`;

    item.addEventListener('click',()=>{
      state.selectedStation=station;
      closeStationSelect();
      renderTheke();
      updateHeader('#view-theke');
    });

    list.appendChild(item);
  });
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
      if(!confirm(`${w.waiter} wirklich abmelden?`)) return;
      try{
        await api(`/api/sessions/${encodeURIComponent(w.waiter)}`, {method:'DELETE'});
        state.sessions=await api('/api/sessions');
        renderWaiterOverview();
        renderTheke();
      }catch(e){
        alert('Fehler beim Abmelden: '+e.message);
      }
    });
    const leftDiv=document.createElement('div');
    leftDiv.append(nameDiv,timeDiv);
    item.append(leftDiv,logoutBtn);
    list.appendChild(item);
  });
}

function updateHeader(viewId){
  const titles={'#view-login':'Login','#view-tables':'Tische','#view-products':'Produkte','#view-theke':'Theke','#view-cash':'Kassieren','#view-cash-detail':'Bestellung','#view-admin':'Admin','#view-pos-history':'Letzte Bestellungen'};
  let title=titles[viewId]||'Bestellsystem';
  if(viewId==='#view-theke' && state.selectedStation){
    title=`Station: ${state.selectedStation}`;
  }
  $('#hdr-title').textContent=title;
  const onLogin=viewId==='#view-login';
  const isTablesView=viewId==='#view-tables';
  const isThekeView=viewId==='#view-theke';

  // Prüfen ob es Produkte mit Stationen gibt
  const hasStationProducts=state.products.some(p=>p.station);

  $('#btn-logout').classList.toggle('hidden', onLogin || viewId==='#view-products' || viewId==='#view-pos-history' || viewId==='#view-cash' || viewId==='#view-cash-detail');
  $('#btn-euro').classList.toggle('hidden', !(state.role==='waiter' && !onLogin && viewId!=='#view-products' && viewId!=='#view-cash' && viewId!=='#view-cash-detail'));
  $('#btn-back-header').classList.toggle('hidden', !(viewId==='#view-products' || viewId==='#view-pos-history' || viewId==='#view-cash' || viewId==='#view-cash-detail'));
  $('#btn-send-header').classList.toggle('hidden', viewId!=='#view-products');
  $('#btn-pos-toggle').classList.toggle('hidden', viewId!=='#view-theke' || state.role!=='bar' || state.selectedStation!==null);
  $('#btn-pos-history').classList.toggle('hidden', !(viewId==='#view-theke' && state.role==='bar' && state.selectedStation===null));
  $('#btn-station-select').classList.toggle('hidden', !(state.role==='bar' && isThekeView && hasStationProducts));
  $('#btn-station-select').classList.toggle('active', state.selectedStation!==null);
  $('#hdr-right').classList.toggle('hidden', viewId!=='#view-cash-detail');
  $('#btn-fav-settings').classList.toggle('hidden', !(state.role==='waiter' && isTablesView));
  $('#btn-fav-filter').classList.toggle('hidden', !(state.role==='waiter' && isTablesView));
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

  // Update connection status indicator
  updateConnectionStatus();
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
}
function setRole(r){ state.role=r; $$('.role-switch .role').forEach(b=>b.classList.toggle('active', b.dataset.role===r)); const isWaiter=r==='waiter'; $('#name-wrap').classList.toggle('hidden', !isWaiter); $('#pin-wrap').classList.toggle('hidden', isWaiter); }
$$('.role-switch .role').forEach(b=>on(b,'click',()=>setRole(b.dataset.role))); setRole('waiter');

on('#btn-login','click', async ()=>{
  try{
    if(state.role==='waiter'){
      const name=$('#inp-name').value.trim();
      if(!name) return alert('Bitte Name eingeben');
      state.user=name;
      await loadInitial();
      loadFavorites();
      await startHeartbeat();
      await requestWakeLock();

      // 🚀 Connect WebSocket (Health-Check läuft weiter bis WS-onopen stopLoginHealthCheck aufruft)
      connectWebSocket();

      renderTables();
      show('#view-tables');
      pollOrders(); // Fallback polling (30s)
    }
    else if(state.role==='bar'){
      const pin=$('#inp-pin').value.trim();
      if(!pin||pin.length<4) return alert('Bitte gültige PIN eingeben');

      // Validate PIN against server
      const authResult = await api('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ role: 'bar', pin })
      });

      if(!authResult.success) return alert('Ungültige PIN');

      state.user='Theke';
      await loadInitial();
      await requestWakeLock();

      // 🚀 Connect WebSocket (Health-Check läuft weiter bis WS-onopen stopLoginHealthCheck aufruft)
      connectWebSocket();

      renderTheke();
      show('#view-theke');
      pollOrders(); // Fallback polling (30s)
    }
    else {
      const pin=$('#inp-pin').value.trim();
      if(!pin||pin.length<4) return alert('Bitte gültige PIN eingeben');

      // Validate PIN against server
      const authResult = await api('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ role: 'admin', pin })
      });

      if(!authResult.success) return alert('Ungültige PIN');

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
    alert('Fehler: '+e.message);
  }
});
on('#btn-logout','click', async ()=>{
  if(!confirm('Möchten Sie sich wirklich abmelden?')) return;
  releaseWakeLock();
  await stopHeartbeat();

  // 🚀 Disconnect WebSocket
  disconnectWebSocket();

  // Zurück zur Login-Seite: Health-Check neu starten für Verbindungsanzeige
  startLoginHealthCheck();

  location.reload();
});
on('#btn-euro','click', ()=>{ renderCash(); show('#view-cash'); });
on('#btn-back-header','click', ()=>{
  const currentView=$$('.view').find(v=>!v.classList.contains('hidden'));
  if(currentView && currentView.id==='view-pos-history') show('#view-theke');
  else if(currentView && currentView.id==='view-cash-detail'){ renderCash(); show('#view-cash'); }
  else if(currentView && currentView.id==='view-cash') show('#view-tables');
  else show('#view-tables');
});
on('#btn-send-header','click', ()=>sendOrder());
on('#btn-pos-toggle','click', ()=>{ state.posMode=!state.posMode; $('#btn-pos-toggle').textContent=state.posMode?'POS: AN':'POS: AUS'; $('#btn-pos-toggle').classList.toggle('active', state.posMode); renderTheke(); updateHeader('#view-theke'); });
on('#btn-pos-history','click', ()=>{ renderPOSHistory(); show('#view-pos-history'); });
on('#btn-fav-filter','click', ()=>{ state.favoritesFilterActive=!state.favoritesFilterActive; renderTables(); updateHeader('#view-tables'); });
on('#btn-fav-settings','click', ()=>openFavoritesSettings());
on('#btn-close-fav-modal','click', ()=>closeFavoritesSettings());
on('#btn-close-fav-modal-footer','click', ()=>closeFavoritesSettings());
on('#btn-clear-all-fav','click', ()=>{ if(confirm('Wirklich alle Favoriten entfernen?')){ clearAllFavorites(); renderFavoritesSettings(); renderTables(); } });
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

      // Check if we're in cash view (detail or overview)
      const inCashView = !$('#view-cash').classList.contains('hidden');

      // Update cash detail view if we're in it
      if(currentCashOrder && currentCashOrder.id==orderId){
        currentCashOrder=state.orders.find(o=>o.id==orderId);
        if(!currentCashOrder || currentCashOrder.status==='paid'){
          // Order fully paid, return to cash overview
          renderCash();
          renderTables();
          show('#view-cash');
        } else {
          // Still unpaid items, refresh detail view
          selectedItems.clear();
          renderCashDetail();
        }
      } else if(inCashView){
        // We're in cash overview (not detail), just refresh it
        renderCash();
        renderTables();
      } else {
        // Not in cash view, refresh theke
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
        const orderRes=await api('/api/orders',{method:'POST', body:JSON.stringify({ table_id: table, waiter: 'POS', items })});
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

    let pressTimer=null;
    b.addEventListener('touchstart',(e)=>{
      pressTimer=setTimeout(()=>showTableContextMenu(e,t.id),500);
    });
    b.addEventListener('touchend',()=>{
      if(pressTimer){ clearTimeout(pressTimer); pressTimer=null; }
    });
    b.addEventListener('mousedown',(e)=>{
      pressTimer=setTimeout(()=>showTableContextMenu(e,t.id),500);
    });
    b.addEventListener('mouseup',()=>{
      if(pressTimer){ clearTimeout(pressTimer); pressTimer=null; }
    });
    b.addEventListener('mouseleave',()=>{
      if(pressTimer){ clearTimeout(pressTimer); pressTimer=null; }
    });
    b.addEventListener('click',(e)=>{
      if(pressTimer){ clearTimeout(pressTimer); pressTimer=null; }
      openProducts(t.id);
    });

    grid.appendChild(b);
  });
}

function showTableContextMenu(e,tableId){
  e.preventDefault();
  e.stopPropagation();
  toggleFavorite(tableId);
  renderTables();
}
let currentTable=null; let basket=new Map();
let currentCommentProduct=null;
function openProducts(tid){ currentTable=tid; $('#prod-table-label').textContent='Tisch '+tableDisplayNum(tid); basket.clear(); renderProducts(); show('#view-products'); }
function contrastColor(hex){ if(!hex) return '#0b0c0e'; const h=hex.replace('#',''); if(h.length!=6) return '#0b0c0e'; const r=parseInt(h[0]+h[1],16), g=parseInt(h[2]+h[3],16), b=parseInt(h[4]+h[5],16); const yiq=((r*299)+(g*587)+(b*114))/1000; return yiq>=160 ? '#0b0c0e':'#ffffff'; }
function renderProducts(){
  const grid=$('#products-grid');
  grid.innerHTML='';
  state.products.filter(p=>p.active).forEach(p=>{
    const card=document.createElement('div');
    card.className='product-btn product-v1';
    card.style.userSelect='none';
    card.style.webkitUserSelect='none';
    card.style.webkitTouchCallout='none';

    if(p.color){
      if(p.half){
        card.style.background=`linear-gradient(to top, ${p.color} 50%, transparent 50%)`;
        card.style.borderColor='rgba(0,0,0,.1)';
      } else {
        card.style.background=p.color;
        card.style.borderColor='rgba(0,0,0,.1)';
        const col=contrastColor(p.color);
        card.style.color=col;
      }
      card.style.boxShadow='0 6px 16px rgba(0,0,0,.08)';
    }

    const minus=document.createElement('button');
    minus.className='minus';
    minus.setAttribute('aria-label','Minus');
    minus.addEventListener('click',(e)=>{
      e.stopPropagation();
      addQty(p.id,-1);
    });

    const name=document.createElement('div');
    name.className='name';
    const parts=p.name.split(' ');
    if(parts.length>1) name.innerHTML=parts[0]+'<br>'+parts.slice(1).join(' ');
    else name.textContent=p.name;

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

    let pressTimer=null;
    card.addEventListener('touchstart',(e)=>{
      pressTimer=setTimeout(()=>openCommentDialog(p.id),500);
    });
    card.addEventListener('touchend',()=>{
      if(pressTimer){ clearTimeout(pressTimer); pressTimer=null; }
    });
    card.addEventListener('mousedown',(e)=>{
      pressTimer=setTimeout(()=>openCommentDialog(p.id),500);
    });
    card.addEventListener('mouseup',()=>{
      if(pressTimer){ clearTimeout(pressTimer); pressTimer=null; }
    });
    card.addEventListener('mouseleave',()=>{
      if(pressTimer){ clearTimeout(pressTimer); pressTimer=null; }
    });
    card.addEventListener('click',(e)=>{
      if(pressTimer){ clearTimeout(pressTimer); pressTimer=null; }
      addQty(p.id,+1);
    });

    grid.appendChild(card);
  });
  updateHeader('#view-products');
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
  renderProducts();
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
async function sendOrder(){ if(basket.size===0) return alert('Bitte Produkte auswählen'); const items=orderItemsArray(); await api('/api/orders',{method:'POST', body:JSON.stringify({ table_id: currentTable, waiter: state.user, items })}); basket.clear(); state.orders=await api('/api/orders'); renderTables(); show('#view-tables'); }

/* Cash */
function orderTotal(o){ return o.items.filter(it=>!it.paid).reduce((s,it)=>s+it.price,0); }
function renderCash(){
  const wrap=$('#cash-list');
  wrap.innerHTML='';
  const mine=state.orders.filter(o=>o.waiter===state.user && o.status!=='paid');
  if(mine.length===0){
    wrap.innerHTML='<div class="muted">Keine offenen Bestellungen.</div>';
    return;
  }
  mine.sort((a,b)=>a.table_id-b.table_id||a.created_at.localeCompare(b.created_at));
  mine.forEach(o=>{
    const card=document.createElement('div');
    card.className='cash-card clickable';
    card.addEventListener('click',()=>openCashDetail(o.id));

    const row=document.createElement('div');
    row.className='row';
    const left=document.createElement('div');
    const tableLabel=o.waiter==='POS'?'POS':`Tisch ${tableDisplayNum(o.table_id)}`;
    left.innerHTML=`<strong>${tableLabel}</strong> · <span class="muted">${fmtAgeMinutes(o.created_at)}</span>`;
    const right=document.createElement('div');
    right.style.display='flex';
    right.style.flexDirection='column';
    right.style.alignItems='flex-end';
    right.style.gap='8px';
    const price=document.createElement('div');
    price.innerHTML=`<strong>${fmtEuro(orderTotal(o))}</strong>`;

    // Button-Container für Rückgeld + Alles kassiert
    const btnRow=document.createElement('div');
    btnRow.style.display='flex';
    btnRow.style.gap='24px';
    btnRow.style.width='100%';

    // Rückgeld-Button
    const changeBtn=document.createElement('button');
    changeBtn.className='ghost';
    changeBtn.style.padding='8px';
    changeBtn.style.minHeight='40px';
    changeBtn.title='Rückgeld berechnen';
    changeBtn.innerHTML='<span class="material-symbols-outlined">calculate</span>';
    changeBtn.addEventListener('click', (e)=>{
      e.stopPropagation();
      openChangeModal(orderTotal(o), o.id);
    });

    // Alles kassiert Button
    const btn=document.createElement('button');
    btn.className='primary';
    btn.style.flex='1';
    btn.innerHTML='<span class="material-symbols-outlined">check</span> Alles kassiert';
    btn.addEventListener('click', async (e)=>{
      e.stopPropagation();
      await api(`/api/orders/${o.id}/pay`,{method:'POST'});
      state.orders=await api('/api/orders');
      renderCash();
      renderTables();
    });

    btnRow.append(changeBtn, btn);
    right.append(price, btnRow);
    row.append(left,right);
    card.appendChild(row);
    wrap.appendChild(card);
  });
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
  hdrRight.innerHTML=`<strong>${tableName}</strong> · <span class="muted">${fmtAgeMinutes(currentCashOrder.created_at)}</span>`;
  hdrRight.classList.remove('hidden');
}

function renderCashDetail(){
  if(!currentCashOrder) return;
  const wrap=$('#cash-detail-content');
  wrap.innerHTML='';

  const itemsList=document.createElement('div');
  itemsList.className='cash-detail-items';

  const unpaidItems=currentCashOrder.items.filter(it=>!it.paid);

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
    right.innerHTML=`<strong>${fmtEuro(group.price*selectedCount)}</strong>`;

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
      renderCash();
      renderTables();
      show('#view-cash');
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
    renderCash();
    renderTables();
    show('#view-cash');
  });

  actions.append(paySelectedBtn,payAllBtn);
  wrap.appendChild(actions);
}

/* Theke */
function isOrderReady(o){ return o.items.length>0 && o.items.every(i=>i.ready); }
function productName(id){ const p=state.products.find(x=>x.id===id); return p? p.name : ('P'+id); }
function productStation(id){ const p=state.products.find(x=>x.id===id); return p? p.station : null; }
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
      if(station===state.selectedStation && !item.ready){
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
    empty.innerHTML='<h3>Keine offenen Bestellungen</h3><p>Alle Produkte für diese Station sind bereit.</p>';
    cols.appendChild(empty);
    return;
  }

  // Gruppiere nach Produkt-ID UND Kommentar (damit Produkte mit/ohne Kommentar separate Kacheln bekommen)
  const grouped=new Map();
  stationItems.forEach(item=>{
    const key=`${item.product_id}_${item.comment||''}`;
    if(!grouped.has(key)){
      grouped.set(key,{
        product_id:item.product_id,
        name:productName(item.product_id),
        comment:item.comment||null,
        items:[],
        oldest_created_at:null
      });
    }
    const group=grouped.get(key);
    group.items.push(item);
    // Speichere das älteste created_at für diese Gruppe
    if(!group.oldest_created_at || item.created_at<group.oldest_created_at){
      group.oldest_created_at=item.created_at;
    }
  });

  // Sortiere Gruppen nach ältestem Bestellzeitpunkt (älteste zuerst)
  const sortedGroups=Array.from(grouped.values()).sort((a,b)=>{
    return new Date(a.oldest_created_at) - new Date(b.oldest_created_at);
  });

  // Erstelle Produkt-Kacheln (wie in Bedienungs-Ansicht)
  const grid=document.createElement('div');
  grid.className='grid products';

  sortedGroups.forEach(group=>{
    const product=state.products.find(p=>p.id===group.product_id);
    const card=document.createElement('div');
    card.className='product-btn product-v1 station-product';
    card.style.position='relative';

    if(product&&product.color){
      if(product.half){
        card.style.background=`linear-gradient(to top, ${product.color} 50%, transparent 50%)`;
        card.style.borderColor='rgba(0,0,0,.1)';
      } else {
        card.style.background=product.color;
        card.style.borderColor='rgba(0,0,0,.1)';
        const col=contrastColor(product.color);
        card.style.color=col;
      }
      card.style.boxShadow='0 6px 16px rgba(0,0,0,.08)';
    }

    const badge=document.createElement('div');
    badge.className='badge';
    badge.style.position='absolute';
    badge.style.top='8px';
    badge.style.right='8px';
    badge.style.fontSize='27px';
    badge.style.fontWeight='bold';
    badge.textContent=group.items.length;

    const tableNums=[...new Set(group.items.map(it=>it.waiter==='POS'?'POS':`T${tableDisplayNum(it.table_id)}`))].join(', ');

    // Kommentar anzeigen (falls vorhanden)
    let commentDiv=null;
    if(group.comment){
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
      tableNumsInName.textContent=tableNums;
      tableNumsInName.style.fontSize='14px';
      tableNumsInName.style.fontWeight='700';
      tableNumsInName.style.opacity='0.75';

      const productNameText=document.createElement('div');
      productNameText.textContent=group.name;
      productNameText.style.fontSize='1.5em';
      productNameText.style.fontWeight='800';

      name.append(tableNumsInName,productNameText);

      commentDiv=document.createElement('div');
      commentDiv.className='item-comment';
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
      commentDiv.appendChild(document.createTextNode(group.comment));

      card.append(badge,name,commentDiv);
    } else {
      // Standard: Name zentral, Tischnummer unten
      const name=document.createElement('div');
      name.className='name';
      name.textContent=group.name;
      name.style.fontSize='1.5em';
      name.style.fontWeight='800';
      name.style.flex='1';
      name.style.display='flex';
      name.style.alignItems='center';
      name.style.justifyContent='center';
      name.style.position='relative';
      name.style.zIndex='1';

      const tables=document.createElement('div');
      tables.textContent=tableNums;
      tables.style.fontSize='16px';
      tables.style.opacity='0.75';
      tables.style.textAlign='center';
      tables.style.fontWeight='700';
      tables.style.width='100%';

      card.append(badge,name,tables);
    }

    card.addEventListener('click',async ()=>{
      // Markiere nur das erste Item als bereit (Anzahl reduziert sich um 1)
      const firstItem = group.items[0];
      await api(`/api/orders/${firstItem.order_id}/items/${firstItem.id}/ready`,{method:'POST'});
      state.orders=await api('/api/orders');
      renderTheke();
    });

    grid.appendChild(card);
  });

  cols.appendChild(grid);
}

function renderKitchenMode(){
  const cols=$('#theke-columns');
  cols.innerHTML='';
  cols.className='theke-columns';

  // Sammle aktive Bediener (aus Sessions) - POS NICHT filtern
  const activeWaiters=state.sessions.map(s=>s.waiter);

  // Gruppiere offene Bestellungen nach Bediener
  const groups={};
  state.orders.filter(o=>{
    if(o.status==='picked') return false;
    if(o.waiter==='POS') return true; // POS: auch 'paid' anzeigen
    return o.status!=='paid'; // Andere: nur wenn nicht 'paid'
  }).forEach(o=>{
    (groups[o.waiter]=groups[o.waiter]||[]).push(o);
  });

  // Füge POS hinzu, wenn POS-Bestellungen existieren
  const allWaiters=[...activeWaiters];
  if(groups['POS'] && groups['POS'].length>0 && !allWaiters.includes('POS')){
    allWaiters.push('POS');
  }

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

    if(list.length===0){
      const empty=document.createElement('div');
      empty.className='muted';
      empty.style.padding='12px';
      empty.style.textAlign='center';
      empty.textContent='Keine offenen Bestellungen';
      col.appendChild(empty);
    } else {
      list.forEach(o=>{
        const card=document.createElement('div');
        card.className='order-card';
        const layout=(state.config.theke_layout||'badges');
        const row=document.createElement('div');
        row.className='row';
        const meta=document.createElement('div');
        meta.className='meta';
        const h=document.createElement('div');
        const tableLabel=o.waiter==='POS'?'POS':`Tisch ${tableDisplayNum(o.table_id)}`;
        h.innerHTML=`<strong>${tableLabel}</strong>`;
        const t=document.createElement('div');
        t.className='time';
        t.textContent=fmtAgeMinutes(o.created_at);
        meta.append(h,t);
        if(layout==='badges'){
          const b=document.createElement('span');
          const ready=isOrderReady(o);
          b.className='status '+(ready?'ready':'open');
          b.textContent=ready?'bereit':'offen';
          row.append(meta,b);
        } else {
          card.classList.add(isOrderReady(o)?'bg-ready':'bg-open');
          row.append(meta,document.createElement('span'));
        }
        card.appendChild(row);
        const items=document.createElement('div');
        items.className='items';
        o.items.forEach(it=>{
          const line=document.createElement('div');
          line.className='item '+(it.ready?'ready':'');
          line.textContent=productName(it.product_id);
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
          line.addEventListener('click', async ()=>{
            await api(`/api/orders/${o.id}/items/${it.id}/toggle-ready`,{method:'PATCH'});
            state.orders=await api('/api/orders');
            renderTheke();
          });
          items.appendChild(line);
        });
        card.appendChild(items);
        const actions=document.createElement('div');
        actions.className='actions';
        const left=document.createElement('div');
        left.className='left';
        const right=document.createElement('div');
        right.className='right';
        const allReady=document.createElement('button');
        allReady.className='outline order-action-btn';
        allReady.textContent='Alle bereit';
        allReady.addEventListener('click', async ()=>{
          for(const it of o.items){
            if(!it.ready) await api(`/api/orders/${o.id}/items/${it.id}/toggle-ready`,{method:'PATCH'});
          }
          state.orders=await api('/api/orders');
          renderTheke();
        });
        left.appendChild(allReady);
        const pick=document.createElement('button');
        pick.className='outline order-action-btn';
        pick.textContent='Abgeholt';
        pick.addEventListener('click', async ()=>{
          await api(`/api/orders/${o.id}/pickup`,{method:'POST'});
          state.orders=await api('/api/orders');
          renderTheke();
        });
        right.appendChild(pick);
        actions.append(left,right);
        card.appendChild(actions);
        col.appendChild(card);
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
  state.orders.filter(o=>{
    if(o.status==='picked') return false;
    if(o.waiter==='POS') return true; // POS: auch 'paid' anzeigen
    return o.status!=='paid'; // Andere: nur wenn nicht 'paid'
  }).forEach(o=>{
    (groups[o.waiter]=groups[o.waiter]||[]).push(o);
  });

  // Füge POS hinzu, wenn POS-Bestellungen existieren
  const allWaiters=[...activeWaiters];
  if(groups['POS'] && groups['POS'].length>0 && !allWaiters.includes('POS')){
    allWaiters.push('POS');
  }

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

  // Bei mehreren Bedienern: Erstelle für jeden eine eigene theke-col
  // Bei einem Bediener: Nur eine theke-col
  waiters.forEach(w=>{
    const list=groups[w]||[];

    // Im POS-Modus: Überspringe Bedienungen ohne offene Bestellungen
    if(list.length===0) return;

    list.sort((a,b)=>a.created_at.localeCompare(b.created_at));

    const col=document.createElement('div');
    col.className='theke-col';

    // Name wie bei POS:AUS als col-title
    const title=document.createElement('div');
    title.className='col-title';
    title.textContent=w||'—';
    col.appendChild(title);

    list.forEach(o=>{
        const card=document.createElement('div');
        card.className='order-card';
        const layout=(state.config.theke_layout||'badges');
        const row=document.createElement('div');
        row.className='row';
        const meta=document.createElement('div');
        meta.className='meta';
        const h=document.createElement('div');
        const tableLabel=o.waiter==='POS'?'POS':`Tisch ${tableDisplayNum(o.table_id)}`;
        h.innerHTML=`<strong>${tableLabel}</strong>`;
        const t=document.createElement('div');
        t.className='time';
        t.textContent=fmtAgeMinutes(o.created_at);
        meta.append(h,t);
        if(layout==='badges'){
          const b=document.createElement('span');
          const ready=isOrderReady(o);
          b.className='status '+(ready?'ready':'open');
          b.textContent=ready?'bereit':'offen';
          row.append(meta,b);
        } else {
          card.classList.add(isOrderReady(o)?'bg-ready':'bg-open');
          row.append(meta,document.createElement('span'));
        }
        card.appendChild(row);
        const items=document.createElement('div');
        items.className='items';
        o.items.forEach(it=>{
          const line=document.createElement('div');
          line.className='item '+(it.ready?'ready':'');
          line.textContent=productName(it.product_id);
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
          line.addEventListener('click', async ()=>{
            await api(`/api/orders/${o.id}/items/${it.id}/toggle-ready`,{method:'PATCH'});
            state.orders=await api('/api/orders');
            renderTheke();
          });
          items.appendChild(line);
        });
        card.appendChild(items);
        const actions=document.createElement('div');
        actions.className='actions';
        const left=document.createElement('div');
        left.className='left';
        const right=document.createElement('div');
        right.className='right';
        const allReady=document.createElement('button');
        allReady.className='outline order-action-btn';
        allReady.textContent='Alle bereit';
        allReady.addEventListener('click', async ()=>{
          for(const it of o.items){
            if(!it.ready) await api(`/api/orders/${o.id}/items/${it.id}/toggle-ready`,{method:'PATCH'});
          }
          state.orders=await api('/api/orders');
          renderTheke();
        });
        left.appendChild(allReady);
        const pick=document.createElement('button');
        pick.className='outline order-action-btn';
        pick.textContent='Abgeholt';
        pick.addEventListener('click', async ()=>{
          await api(`/api/orders/${o.id}/pickup`,{method:'POST'});
          state.orders=await api('/api/orders');
          renderTheke();
        });
        right.appendChild(pick);
        actions.append(left,right);
        card.appendChild(actions);
        col.appendChild(card);
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

  state.products.filter(p=>p.active).forEach(p=>{
    const card=document.createElement('div');
    card.className='product-btn product-v1';
    if(p.color){
      if(p.half){
        card.style.background=`linear-gradient(to top, ${p.color} 50%, transparent 50%)`;
        card.style.borderColor='rgba(0,0,0,.1)';
      } else {
        card.style.background=p.color;
        card.style.borderColor='rgba(0,0,0,.1)';
        const col=contrastColor(p.color);
        card.style.color=col;
      }
      card.style.boxShadow='0 6px 16px rgba(0,0,0,.08)';
    }
    const minus=document.createElement('button');
    minus.className='minus';
    minus.setAttribute('aria-label','Minus');
    minus.addEventListener('click',(e)=>{
      e.stopPropagation();
      addPOSQty(p.id,-1);
    });
    const name=document.createElement('div');
    name.className='name';
    const parts=p.name.split(' ');
    if(parts.length>1) name.innerHTML=parts[0]+'<br>'+parts.slice(1).join(' ');
    else name.textContent=p.name;
    const badge=document.createElement('div');
    badge.className='badge';
    badge.textContent=state.posBasket.get(p.id)||0;
    const top=document.createElement('div');
    top.className='topbar';
    top.append(minus,badge);
    card.append(top,name);
    card.addEventListener('click',()=>{
      addPOSQty(p.id,+1);
      badge.textContent=state.posBasket.get(p.id)||0;
    });
    prodGrid.appendChild(card);
  });

  productsArea.appendChild(prodGrid);
  container.appendChild(productsArea);

  // Untere 50%: Checkout (wie POS-Only Modus)
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
      const orderResponse=await api('/api/orders',{method:'POST', body:JSON.stringify({ table_id: table, waiter: 'POS', items })});
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
      const orderRes=await api('/api/orders',{method:'POST', body:JSON.stringify({ table_id: table, waiter: 'POS', items })});
      await api(`/api/orders/${orderRes.id}/pay`,{method:'POST'});
      state.posBasket.clear();
      state.orders=await api('/api/orders');
      renderTheke();
    });

    actions.append(clearBtn,payBtn);
  }

  checkoutArea.appendChild(actions);

  container.appendChild(checkoutArea);
}

function addPOSQty(pid,delta){
  const q=Math.max(0,(state.posBasket.get(pid)||0)+delta);
  if(q===0) state.posBasket.delete(pid);
  else state.posBasket.set(pid,q);
  renderTheke();
}

/* POS History */
function renderPOSHistory(){
  const wrap=$('#pos-history-list');
  wrap.innerHTML='';

  // History: Zeige Bestellungen die abgeholt ODER vollständig bezahlt sind
  const posOrders=state.orders.filter(o=>{
    if(o.status==='picked') return true; // Abgeholt immer anzeigen
    if(o.status==='paid') return true; // Ganze Bestellung als bezahlt markiert
    const allPaid=o.items.every(it=>it.paid);
    return allPaid; // Oder alle Items bezahlt
  }).sort((a,b)=>b.created_at.localeCompare(a.created_at)).slice(0,50);

  if(posOrders.length===0){
    wrap.innerHTML='<div class="muted">Keine abgeschlossenen Bestellungen vorhanden.</div>';
    return;
  }

  posOrders.forEach(o=>{
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

    // Nur Bezahlt-Status anzeigen
    const allPaid=o.status==='paid' || o.items.every(it=>it.paid);
    if(allPaid){
      const paidBadge=document.createElement('span');
      paidBadge.className='status-badge status-paid';
      paidBadge.textContent='bezahlt';
      middle.appendChild(paidBadge);
    }

    const right=document.createElement('div');
    right.innerHTML=`<strong>${fmtEuro(orderTotal(o))}</strong>`;

    row.append(left,middle,right);
    card.appendChild(row);

    const items=document.createElement('div');
    items.className='items';
    items.style.marginTop='8px';

    const grouped=new Map();
    o.items.forEach(it=>{
      const name=productName(it.product_id);
      grouped.set(name,(grouped.get(name)||0)+1);
    });

    grouped.forEach((qty,name)=>{
      const line=document.createElement('div');
      line.className='item';
      line.textContent=`${qty}x ${name}`;
      items.appendChild(line);
    });

    card.appendChild(items);
    wrap.appendChild(card);
  });
}

/* Admin */
async function adminInit(){ $$('.admin-tabs .tab').forEach(btn=>on(btn,'click',()=>{ $$('.admin-tabs .tab').forEach(b=>b.classList.remove('active')); btn.classList.add('active'); const tab=btn.dataset.tab; $$('.admin-section').forEach(s=>s.classList.add('hidden')); if(tab==='tables'){ $('#admin-tables').classList.remove('hidden'); adminTablesLoad(); } if(tab==='products'){ $('#admin-products').classList.remove('hidden'); adminProductsLoad(); } if(tab==='stations'){ $('#admin-stations').classList.remove('hidden'); adminStationsLoad(); } if(tab==='report'){ $('#admin-report').classList.remove('hidden'); adminReportLoad(); } if(tab==='system'){ $('#admin-system').classList.remove('hidden'); adminSystemLoad(); } })); adminTablesLoad(); on('#btn-save-cols','click', adminSaveCols); on('#btn-save-theke-layout','click', adminSaveThekeLayout); on('#btn-apply-tables','click', adminApplyTables); on('#btn-add-product','click', adminAddProduct); on('#btn-add-station','click', adminAddStation); on('#btn-refresh-report','click', adminReportLoad); on('#btn-reset-report','click', adminResetReport); on('#btn-refresh-logs','click', adminSystemLoad); on('#btn-save-pin-bar','click', adminSavePinBar); on('#btn-save-pin-admin','click', adminSavePinAdmin); }
async function adminTablesLoad(){ state.config=await api('/api/config'); $('#cfg-cols').value=state.config.grid_cols??4; $('#cfg-theke-layout').value=(state.config.theke_layout??'badges'); const tables=await api('/api/tables'); $('#tbl-count').textContent=tables.length; $('#tbl-target').value=tables.length; const prev=$('#admin-tables-preview'); prev.innerHTML=''; prev.style.setProperty('--cols', Math.max(3, Math.min(6, +($('#cfg-cols').value||4)))); tables.forEach((t,i)=>{ const b=document.createElement('button'); b.className='table-btn'; b.textContent=i+1; prev.appendChild(b); }); }
async function adminSaveCols(){ const n=Math.max(3,Math.min(6,+($('#cfg-cols').value||4))); await api('/api/config',{method:'PUT', body:JSON.stringify({grid_cols:n})}); state.config.grid_cols=n; await adminTablesLoad(); }
async function adminSaveThekeLayout(){ const v=$('#cfg-theke-layout').value||'badges'; await api('/api/config',{method:'PUT', body:JSON.stringify({theke_layout:v})}); state.config.theke_layout=v; await adminTablesLoad(); }
async function adminApplyTables(){ const target=Math.max(1,Math.min(200, +($('#tbl-target').value||16))); const tables=await api('/api/tables'); const diff=target-tables.length; if(diff===0) return; if(diff>0){ for(let i=0;i<diff;i++) await api('/api/tables',{method:'POST', body:JSON.stringify({name:null})}); } else { const ids=tables.map(t=>t.id).sort((a,b)=>b-a).slice(0,-diff); for(const id of ids) await api(`/api/tables/${id}`,{method:'DELETE'}); } await adminTablesLoad(); }
function priceToNumber(s){ if(typeof s==='number') return s; s=(s||'').toString().trim().replace('.','').replace(',','.'); return parseFloat(s)||0; }
async function adminProductsLoad(){ const list=await api('/api/products'); state.products=list; const stations=(state.config.stations||[]); const tbl=$('#prod-table'); tbl.innerHTML=''; const thead=document.createElement('thead'); thead.innerHTML='<tr><th style="width:78px;">Reihenfolge</th><th>ID</th><th>Name</th><th>Preis</th><th>Farbe</th><th>Station</th><th>Aktiv</th><th>1/2</th><th></th></tr>'; tbl.appendChild(thead); const tb=document.createElement('tbody'); list.forEach((p,idx)=>{ const tr=document.createElement('tr'); tr.dataset.id=p.id; const color=p.color||'#ffffff'; const stationOptions=`<option value="">Keine</option>${stations.map(s=>`<option value="${s}" ${p.station===s?'selected':''}>${s}</option>`).join('')}`; tr.innerHTML=`<td><button class="btn-up" data-id="${p.id}" ${idx===0?'disabled':''}>▲</button> <button class="btn-down" data-id="${p.id}" ${idx===list.length-1?'disabled':''}>▼</button></td><td>${p.id}</td><td><input data-id="${p.id}" data-k="name" value="${p.name}"/></td><td><input data-id="${p.id}" data-k="price" value="${p.price.toFixed(2).replace('.',',')}"/></td><td><input type="color" data-id="${p.id}" data-k="color" value="${color}" class="prod-color"/></td><td><select data-id="${p.id}" data-k="station">${stationOptions}</select></td><td style="text-align:center;"><input type="checkbox" data-id="${p.id}" data-k="active" ${p.active?'checked':''}/></td><td style="text-align:center;"><input type="checkbox" data-id="${p.id}" data-k="half" ${p.half?'checked':''}/></td><td style="text-align:right;"><button class="btn-del" data-id="${p.id}" title="Löschen" aria-label="Löschen">🗑️</button></td>`; tb.appendChild(tr); }); tbl.appendChild(tb);
  tb.addEventListener('click', async (e)=>{ const del=e.target.closest('.btn-del'); if(del){ const id=+del.dataset.id; if(!confirm(`Produkt #${id} wirklich löschen?`)) return; await api(`/api/products/${id}`,{method:'DELETE'}); await adminProductsLoad(); return; } const up=e.target.closest('.btn-up'); const down=e.target.closest('.btn-down'); if(!up&&!down) return; const id=+(up?up.dataset.id:down.dataset.id); const row=tb.querySelector(`tr[data-id="${id}"]`); if(up){ const prev=row.previousElementSibling; if(prev) tb.insertBefore(row,prev); } else { const next=row.nextElementSibling; if(next) tb.insertBefore(next,row); } $$('#prod-table tbody tr .btn-up').forEach((b,i)=> b.disabled=(i===0)); const rows=$$('#prod-table tbody tr'); rows.forEach((r,i)=>{ const dn=r.querySelector('.btn-down'); if(dn) dn.disabled=(i===rows.length-1); }); const ids=$$('#prod-table tbody tr').map(tr=>+tr.dataset.id); await api('/api/products/order',{method:'PUT', body:JSON.stringify({order:ids})}); state.products=await api('/api/products'); });
  let lastColorInput=null;
  $$('.prod-color').forEach(inp=>{ inp.addEventListener('focus',()=>lastColorInput=inp); inp.addEventListener('click',()=>lastColorInput=inp); });
  $$('#fav-colors .swatch').forEach(s=> s.addEventListener('click',()=>{ const c=s.dataset.color; if(lastColorInput) lastColorInput.value=c; }));
  $('#btn-save-all-products').onclick = async ()=>{ const rows=$$('#prod-table tbody tr'); const ops=[]; rows.forEach(tr=>{ const id=+tr.dataset.id; const name=$(`input[data-id="${id}"][data-k="name"]`).value.trim(); const price=priceToNumber($(`input[data-id="${id}"][data-k="price"]`).value); const active=$(`input[data-id="${id}"][data-k="active"]`).checked; const half=$(`input[data-id="${id}"][data-k="half"]`).checked; const color=$(`input[data-id="${id}"][data-k="color"]`).value||null; const station=$(`select[data-id="${id}"][data-k="station"]`).value||null; const cur=state.products.find(p=>p.id===id)||{}; const changed=(name!==cur.name)||(Math.abs(price-(cur.price||0))>1e-9)||(!!active!==!!cur.active)||((color||null)!==(cur.color||null))||(!!half!==!!cur.half)||((station||null)!==(cur.station||null)); if(changed) ops.push(api(`/api/products/${id}`,{method:'PUT', body:JSON.stringify({name,price,active,color,half,station})})); }); if(ops.length===0) return showNotification('Keine Änderungen', 'info'); await Promise.all(ops); await adminProductsLoad(); showNotification('Änderungen gespeichert', 'success'); };
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
      if(!confirm(`Station "${station}" wirklich löschen?`)) return;
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
  if(!name) return alert('Bitte Stationsname eingeben');

  state.config=await api('/api/config');
  const stations=state.config.stations||[];

  if(stations.includes(name)){
    return alert('Diese Station existiert bereits');
  }

  stations.push(name);
  await api('/api/config',{method:'PUT', body:JSON.stringify({stations})});
  $('#station-new-name').value='';
  await adminStationsLoad();
}

async function adminAddProduct(){ const name=$('#p-new-name').value.trim(); const price=priceToNumber($('#p-new-price').value); const color=$('#p-new-color').value||null; if(!name||!price) return alert('Name & Preis erforderlich'); await api('/api/products',{method:'POST', body:JSON.stringify({name,price,color})}); $('#p-new-name').value=''; $('#p-new-price').value=''; $('#p-new-color').value='#ffffff'; await adminProductsLoad(); }
async function adminReportLoad(){ const rep=await api('/api/report/summary'); $('#rep-total').textContent=fmtEuro(rep.total); const tbl=$('#rep-table'); tbl.innerHTML=''; const thead=document.createElement('thead'); thead.innerHTML='<tr><th>Produkt</th><th>Anzahl</th></tr>'; tbl.appendChild(thead); const tb=document.createElement('tbody'); (rep.products||[]).forEach(r=>{ const tr=document.createElement('tr'); tr.innerHTML=`<td>${r.name}</td><td>${r.qty}</td>`; tb.appendChild(tr); }); tbl.appendChild(tb); }
async function adminResetReport(){ if(!confirm('Wirklich alle Bestellungen & Positionen dauerhaft löschen?')) return; await api('/api/report/reset',{method:'POST'}); await adminReportLoad(); }

async function adminSavePinBar() {
  const newPin = $('#pin-bar-input').value.trim();
  if (!newPin) {
    return alert('Bitte neue PIN eingeben');
  }
  if (!/^\d{4,8}$/.test(newPin)) {
    return alert('PIN muss 4-8 Ziffern enthalten');
  }
  try {
    await api('/api/settings/pins', {
      method: 'PUT',
      body: JSON.stringify({ pin_bar: newPin })
    });
    alert('Theke-PIN erfolgreich geändert');
    $('#pin-bar-input').value = '';
    await adminSystemLoad();
  } catch (e) {
    alert('Fehler beim Ändern der PIN: ' + e.message);
  }
}

async function adminSavePinAdmin() {
  const newPin = $('#pin-admin-input').value.trim();
  if (!newPin) {
    return alert('Bitte neue PIN eingeben');
  }
  if (!/^\d{4,8}$/.test(newPin)) {
    return alert('PIN muss 4-8 Ziffern enthalten');
  }
  try {
    await api('/api/settings/pins', {
      method: 'PUT',
      body: JSON.stringify({ pin_admin: newPin })
    });
    alert('Admin-PIN erfolgreich geändert');
    $('#pin-admin-input').value = '';
    await adminSystemLoad();
  } catch (e) {
    alert('Fehler beim Ändern der PIN: ' + e.message);
  }
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

  // Render status metrics
  const metrics=[
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
    item.innerHTML=`<span class="muted">${m.label}:</span><strong>${m.value}</strong>`;
    statusDiv.appendChild(item);
  });

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

// Polling Fallback: Only polls if WebSocket is not connected
async function pollOrders(){
  setInterval(async ()=>{
    try{
      // Only poll if WebSocket is not connected (Fallback mode)
      const wsConnected = state.ws && state.ws.readyState === WebSocket.OPEN;

      if (!wsConnected) {
        console.log('[Polling] WebSocket offline, using polling fallback...');

        const active=['#view-theke','#view-cash','#view-tables','#view-products','#view-admin'];
        if(active.some(v=>!$(v).classList.contains('hidden'))){
          state.orders=await api('/api/orders');
          state.sessions=await api('/api/sessions');
          state.products=await api('/api/products');

          // Check if waiter session still exists
          if(state.role==='waiter' && state.user){
            const mySession=state.sessions.find(s=>s.waiter===state.user);
            if(!mySession){
              alert('Du wurdest von der Theke abgemeldet.');
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

// iOS PWA + Desktop: readonly bei pointerdown entfernen (deckt Touch und Maus ab)
['#inp-name','#inp-pin'].forEach(sel=>{
  const el=$(sel);
  if(!el) return;
  el.addEventListener('pointerdown',()=>el.removeAttribute('readonly'),{passive:true});
});

// Wake Lock und WebSocket bei Sichtbarkeitswechsel reaktivieren (iOS Standby-Wakeup)
document.addEventListener('visibilitychange', async ()=>{
  if(!document.hidden && state.user){
    if(!state.wakeLock) await requestWakeLock();
    // Sofortiger Reconnect-Versuch wenn WS nicht verbunden (z.B. nach Standby)
    if(!state.ws || state.ws.readyState !== WebSocket.OPEN){
      console.log('[WebSocket] Visibility restored – reconnecting immediately');
      connectWebSocket();
    }
  }
});

// Sofortiger Reconnect wenn Netzwerk wieder verfügbar (z.B. nach WLAN-Trennung)
window.addEventListener('online', () => {
  if(state.user && (!state.ws || state.ws.readyState !== WebSocket.OPEN)){
    console.log('[WebSocket] Network online – reconnecting immediately');
    connectWebSocket();
  }
});

// =============================================================================
// iOS/iPad PWA: Scroll-Fixes für Theke
// =============================================================================

// Touchmove Prevention: Verhindert Body-Scroll wenn lock-scroll aktiv
document.addEventListener('touchmove', (e) => {
  if (!document.body.classList.contains('lock-scroll')) return;

  // Scroll erlauben nur innerhalb der Spalten
  const scroller = e.target.closest('.theke-col, .bediener-column, .pos-column, .pos-products-area');
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