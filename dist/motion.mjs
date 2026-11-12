// Keep the artwork responsive to the pointer while the learning controls stay still.
export function enableDepthEffects(root) {
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let surface = null;
  let frame = null;
  let position = null;

  function reset() {
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    position = null;
    surface?.style.removeProperty('--depth-x');
    surface?.style.removeProperty('--depth-y');
    surface = null;
  }

  function paint() {
    frame = null;
    if (!surface?.isConnected || !position) return;
    surface.style.setProperty('--depth-x', `${position.x.toFixed(2)}deg`);
    surface.style.setProperty('--depth-y', `${position.y.toFixed(2)}deg`);
  }

  root.addEventListener('pointermove', event => {
    if (event.pointerType !== 'mouse' || reducedMotion.matches) return;
    const next = event.target.closest('[data-depth]');
    if (next !== surface) reset();
    if (!next) return;
    surface = next;
    const bounds = surface.getBoundingClientRect();
    const horizontal = (event.clientX - bounds.left) / bounds.width - 0.5;
    const vertical = (event.clientY - bounds.top) / bounds.height - 0.5;
    position = { x: vertical * -5, y: horizontal * 7 };
    if (frame === null) frame = requestAnimationFrame(paint);
  });

  root.addEventListener('pointerleave', reset);
  reducedMotion.addEventListener('change', reset);
  window.addEventListener('blur', reset);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) reset();
  });
}
