/* Service-Worker-Registrierung.
   Kein automatischer Reload: ein Neuladen mitten im Betrieb wuerde an der Theke
   eine laufende Eingabe verwerfen. Der Worker liefert network-first, die neue
   Version kommt also beim naechsten regulaeren Laden von selbst. */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then((reg) => {
      // Beim Aufwachen aus dem Standby nach einem neuen Build schauen
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') reg.update().catch(() => {});
      });
    }).catch(() => {});
  });
}
