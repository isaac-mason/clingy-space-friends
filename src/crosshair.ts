// A minimal HUD crosshair: a small white dot at screen centre, plus a left-mouse icon
// + "interact" hint shown to its right when looking at something interactable.
export type Crosshair = {
    dot: HTMLDivElement;
    hint: HTMLDivElement;
};

// A little mouse with the LEFT button filled — so it's clear you left-click to interact.
const LEFT_MOUSE_SVG = `<svg width="11" height="16" viewBox="0 0 20 30" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
  <path d="M10 2 A8 8 0 0 0 2 10 L2 11 L10 11 Z" fill="#fff" fill-opacity="0.95"/>
  <rect x="2" y="2" width="16" height="26" rx="8" stroke="#fff" stroke-width="1.6"/>
  <line x1="10" y1="2" x2="10" y2="11" stroke="#fff" stroke-width="1.3"/>
  <line x1="2.4" y1="11" x2="17.6" y2="11" stroke="#fff" stroke-width="1.3"/>
</svg>`;

export function createCrosshair(): Crosshair {
    // Small white circle, dead centre, with a soft dark outline so it reads on both
    // bright and dark splats.
    const dot = document.createElement('div');
    dot.style.cssText = [
        'position:fixed',
        'left:50%',
        'top:50%',
        'width:6px',
        'height:6px',
        'margin:-3px 0 0 -3px', // centre the 6px dot on the exact midpoint
        'border-radius:50%',
        'background:#fff',
        'box-shadow:0 0 2px rgba(0,0,0,0.9)',
        'pointer-events:none',
        'z-index:1000',
    ].join(';');

    // Left-mouse icon + "interact" label just to the right of the dot, hidden until
    // hovering a target.
    const hint = document.createElement('div');
    hint.innerHTML = `${LEFT_MOUSE_SVG}<span>interact</span>`;
    hint.style.cssText = [
        'position:fixed',
        'left:calc(50% + 14px)',
        'top:50%',
        'transform:translateY(-50%)',
        'display:none', // toggled to 'flex' by setInteractHint
        'align-items:center',
        'gap:6px',
        'font:12px/1 monospace',
        'color:#fff',
        'text-shadow:0 0 3px rgba(0,0,0,0.9)',
        'filter:drop-shadow(0 0 2px rgba(0,0,0,0.9))', // outline the SVG for contrast
        'letter-spacing:0.5px',
        'pointer-events:none',
        'z-index:1000',
    ].join(';');

    document.body.append(dot, hint);
    return { dot, hint };
}

// Show/hide the whole crosshair (e.g. hide it in orbit-camera mode).
export function setCrosshairVisible(crosshair: Crosshair, visible: boolean): void {
    crosshair.dot.style.display = visible ? 'block' : 'none';
    if (!visible) crosshair.hint.style.display = 'none';
}

// Show/hide just the left-mouse "interact" hint next to the dot.
export function setInteractHint(crosshair: Crosshair, visible: boolean): void {
    crosshair.hint.style.display = visible ? 'flex' : 'none';
}
