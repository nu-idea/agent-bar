// Floating pill: shows counts, drags anywhere, click opens the list.
// Dragging is done by hand (not -webkit-app-region) so that a click still registers.
const pillEl = document.getElementById('pill');
const workingEl = document.getElementById('working');
const waitingEl = document.getElementById('waiting');

function render({ working, waiting }) {
  workingEl.textContent = working;
  waitingEl.textContent = waiting;
  pillEl.classList.toggle('busy', working > 0);
  pillEl.classList.toggle('idle', working === 0 && waiting === 0);
  pillEl.classList.toggle('no-waiting', waiting === 0);
}

let drag = null;
pillEl.addEventListener('mousedown', (e) => {
  drag = { x: e.screenX, y: e.screenY, moved: 0 };
});
window.addEventListener('mousemove', (e) => {
  if (!drag) return;
  const dx = e.screenX - drag.x;
  const dy = e.screenY - drag.y;
  if (!dx && !dy) return;
  drag.moved += Math.abs(dx) + Math.abs(dy);
  drag.x = e.screenX;
  drag.y = e.screenY;
  window.agentBar.pillMove(dx, dy);
});
window.addEventListener('mouseup', () => {
  if (!drag) return;
  if (drag.moved < 4) window.agentBar.pillClick();
  else window.agentBar.pillMoved();
  drag = null;
});

window.agentBar.onSummary(render);
window.agentBar.getSummary().then(render);
