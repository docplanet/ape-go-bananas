// The only script that runs inside the review. It adds the per-card Flag
// button, scrolls to a card when the app asks, and says which card is at the
// top so the app's counter stays true when the person scrolls by hand. The
// frame has no same-origin, so this is the whole conversation.
//
// A srcdoc frame inherits the window's CSP, whose script-src has no
// 'unsafe-inline': this script runs because its sha256 is listed in
// tauri.conf.json, and app/test/csp.test.ts fails if the two drift apart.
// Nothing else inline runs in the frame -- a <script> in a card included.
export const FLAG_SCRIPT_BODY = `
const arts = Array.prototype.slice.call(document.querySelectorAll('article'));
arts.forEach((a, i) => {
  const b = document.createElement('button');
  b.textContent = 'Flag';
  b.className = 'flag';
  b.style.cssText = 'float:right;margin-left:8px';
  b.onclick = () => parent.postMessage({ type: 'ape:flag', noteIndex: i }, '*');
  a.querySelector('.idx').prepend(b);
});
window.addEventListener('message', (e) => {
  if (!e.data) return;
  if (e.data.type === 'ape:flagged') {
    arts.forEach((a, i) => {
      a.style.outline = e.data.indexes.includes(i) ? '2px solid #E0B81C' : '';
    });
  }
  if (e.data.type === 'ape:goto' && arts[e.data.index]) {
    arts[e.data.index].scrollIntoView({ block: 'start', behavior: 'smooth' });
  }
});
let queued = false;
window.addEventListener('scroll', () => {
  if (queued) return;
  queued = true;
  requestAnimationFrame(() => {
    queued = false;
    for (let i = 0; i < arts.length; i++) {
      if (arts[i].getBoundingClientRect().bottom > 40) {
        parent.postMessage({ type: 'ape:at', index: i }, '*');
        return;
      }
    }
  });
}, { passive: true });
`;
