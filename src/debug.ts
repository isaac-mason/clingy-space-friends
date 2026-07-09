import type { SparkRenderer } from '@sparkjsdev/spark';
import { debug as ccDebug, kcc, MotionType, rigidBody, type World } from 'crashcat';
import * as THREE from 'three';
import { LightProbeHelper } from 'three/addons/helpers/LightProbeHelper.js';

import type { Character } from './character';
import type { Performance } from './performance';

const GROUND_STATE_NAMES: Record<number, string> = {
    [kcc.GroundState.ON_GROUND]: 'on ground',
    [kcc.GroundState.ON_STEEP_GROUND]: 'on steep',
    [kcc.GroundState.NOT_SUPPORTED]: 'not supported',
    [kcc.GroundState.IN_AIR]: 'in air',
};

export type DebugOverlay = {
    element: HTMLDivElement;
    text: HTMLDivElement;
    /** Whether the text panel is shown (toggled with the backtick key). */
    enabled: boolean;
    /** Whether the navmesh wireframe is drawn (toggled by the checkbox). */
    showNavMesh: boolean;
    /** Camera mode: true = free orbit camera, false = first-person character. */
    orbitMode: boolean;
    /**
     * Line segments for the static collider wireframe (floor + level triangle mesh).
     * Built once via buildColliderDebug — the colliders never move — and toggled
     * on/off with the "collider debug" checkbox.
     */
    colliderLines: THREE.LineSegments;
    /** Whether the light-probe grid gizmos are drawn (toggled by the checkbox). */
    showProbes: boolean;
    /** One THREE.LightProbeHelper per baked probe (SH-shaded sphere). Built on bake. */
    probeGroup: THREE.Group | null;
    /** Whether the crowd-agent cylinders are drawn (toggled by the checkbox). */
    showCrowd: boolean;
    /** Wireframe cylinder per crowd agent (radius × height). Rebuilt each frame. */
    crowdCylinders: THREE.LineSegments;
};

function createCheckbox(label: string, onChange: (checked: boolean) => void): HTMLLabelElement {
    const wrapper = document.createElement('label');
    wrapper.style.cssText = 'display:flex;gap:6px;align-items:center;cursor:pointer;user-select:none';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.addEventListener('change', () => onChange(input.checked));
    wrapper.append(input, label);
    return wrapper;
}

// An always-on labelled range slider that reports its value live, with a readout.
function createRange(
    label: string,
    opts: { min: number; max: number; step: number; value: number },
    onChange: (value: number) => void,
): HTMLLabelElement {
    const wrapper = document.createElement('label');
    wrapper.style.cssText = 'display:flex;gap:6px;align-items:center;cursor:pointer;user-select:none';
    const range = document.createElement('input');
    range.type = 'range';
    range.min = String(opts.min);
    range.max = String(opts.max);
    range.step = String(opts.step);
    range.value = String(opts.value);
    range.style.width = '80px';
    const readout = document.createElement('span');
    readout.textContent = opts.value.toFixed(2);
    range.addEventListener('input', () => {
        const v = Number(range.value);
        readout.textContent = v.toFixed(2);
        onChange(v);
    });
    wrapper.append(label, range, readout);
    return wrapper;
}

// Minimal debug overlay (plain DOM): a text panel showing the camera position
// (toggle with the backtick `) plus checkboxes toggling debug wireframes.
export function createDebugOverlay(perf: Performance): DebugOverlay {
    const element = document.createElement('div');
    element.style.cssText = [
        'position:fixed',
        'top:8px',
        'left:8px',
        'padding:6px 8px',
        'display:none',
        'flex-direction:column',
        'gap:4px',
        'font:12px/1.4 monospace',
        'color:#0f0',
        'background:rgba(0,0,0,0.6)',
        'z-index:1000',
    ].join(';');

    // Static collider wireframe — built once (see buildColliderDebug). Coloured per-vertex.
    const colliderLines = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ vertexColors: true }));
    colliderLines.visible = false;
    colliderLines.frustumCulled = false;

    // Crowd-agent cylinders — rebuilt each frame from the live agents (see updateCrowdDebug).
    const crowdCylinders = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({ color: 0x33e0ff }));
    crowdCylinders.visible = false;
    crowdCylinders.frustumCulled = false;

    const overlay: DebugOverlay = {
        element,
        text: document.createElement('div'),
        enabled: false,
        showNavMesh: false,
        orbitMode: false,
        colliderLines,
        showProbes: false,
        probeGroup: null,
        showCrowd: false,
        crowdCylinders,
    };

    const orbitCheckbox = createCheckbox('orbit camera', (checked) => {
        overlay.orbitMode = checked;
    });

    const colliderCheckbox = createCheckbox('collider debug', (checked) => {
        colliderLines.visible = checked;
    });

    const navmeshCheckbox = createCheckbox('navmesh debug', (checked) => {
        overlay.showNavMesh = checked;
    });

    const probeCheckbox = createCheckbox('light probes', (checked) => {
        overlay.showProbes = checked;
        if (overlay.probeGroup) overlay.probeGroup.visible = checked;
    });

    const crowdCheckbox = createCheckbox('crowd debug', (checked) => {
        overlay.showCrowd = checked;
        crowdCylinders.visible = checked;
    });

    const lodSlider = createRange('lod scale', { min: 0.2, max: 2, step: 0.05, value: perf.lodScale }, (value) => {
        perf.lodScale = value;
    });

    overlay.text.style.cssText = 'white-space:pre;user-select:text;-webkit-user-select:text;cursor:text';

    element.append(orbitCheckbox, colliderCheckbox, navmeshCheckbox, probeCheckbox, crowdCheckbox, lodSlider, overlay.text);
    document.body.appendChild(element);

    window.addEventListener('keydown', (event) => {
        if (event.key === '`') {
            overlay.enabled = !overlay.enabled;
            element.style.display = overlay.enabled ? 'flex' : 'none';
        }
    });

    return overlay;
}

// Live light-probe readout: how many probes were baked, and the R/G/B of the
// currently-sampled scene probe (the lighting the companions are actually getting
// this frame). Near-zero = the capture came back black.
export type ProbeReadout = { count: number; color: THREE.Color };

export function updateDebugOverlay(
    overlay: DebugOverlay,
    camera: THREE.PerspectiveCamera,
    character: Character,
    spark: SparkRenderer,
    probe?: ProbeReadout,
): void {
    if (!overlay.enabled) return;

    const p = camera.position;
    const c = character.kcc.position;
    const ground = GROUND_STATE_NAMES[character.kcc.ground.state] ?? '?';
    const active = spark.activeSplats.toLocaleString();
    const max = spark.maxSplats.toLocaleString();
    let text =
        `mode    ${overlay.orbitMode ? 'orbit' : 'first-person'}\n` +
        `cam     ${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)}\n` +
        `feet    ${c[0].toFixed(2)}, ${c[1].toFixed(2)}, ${c[2].toFixed(2)}  (${ground})\n` +
        `splats  ${active} / ${max}  (lod x${spark.lodSplatScale.toFixed(2)})`;
    if (probe) {
        text += `\nprobes  ${probe.count}  rgb ${probe.color.r.toFixed(2)}, ${probe.color.g.toFixed(2)}, ${probe.color.b.toFixed(2)}`;
    }
    overlay.text.textContent = text;
}

const PROBE_GIZMO_SIZE = 0.15; // radius (m) of each probe helper sphere

// Build (or rebuild) the light-probe grid gizmo: one THREE.LightProbeHelper per
// probe (a sphere shaded by that probe's actual SH, so you see the directional
// lighting — bright side / dark side — not just an average). A fully dark sphere
// means that probe captured nothing (buried in geometry, or a truly unlit spot).
// The backing LightProbes are NOT added to the scene, so they don't light anything;
// the helpers just visualize them. Call once after the probe grid bakes/loads.
export function buildProbeDebug(
    overlay: DebugOverlay,
    scene: THREE.Scene,
    probes: { positions: ArrayLike<number>[]; sh: THREE.SphericalHarmonics3[] },
): void {
    if (overlay.probeGroup) {
        scene.remove(overlay.probeGroup);
        overlay.probeGroup.traverse((o) => {
            if (o instanceof LightProbeHelper) o.dispose();
        });
        overlay.probeGroup = null;
    }

    const n = probes.positions.length;
    if (n === 0) return;

    const group = new THREE.Group();
    for (let i = 0; i < n; i++) {
        const p = probes.positions[i];
        const probe = new THREE.LightProbe(); // detached (not added to scene → lights nothing)
        probe.sh.copy(probes.sh[i]);
        probe.position.set(p[0], p[1], p[2]);
        const helper = new LightProbeHelper(probe, PROBE_GIZMO_SIZE);
        helper.frustumCulled = false;
        group.add(helper);
    }
    group.visible = overlay.showProbes;
    scene.add(group);
    overlay.probeGroup = group;
}

// Build the static collider wireframe once. The colliders (floor box + level triangle
// mesh) never move, so we generate the line segments a single time — after the collider
// is loaded — and thereafter the "collider debug" checkbox just toggles visibility.
// Call this once the physics world's static bodies exist (e.g. after createSplatCollider).
export function buildColliderDebug(overlay: DebugOverlay, world: World): void {
    let total = 0;
    const parts: ReturnType<typeof ccDebug.body>[] = [];
    for (const body of rigidBody.iterate(world)) {
        if (body.motionType !== MotionType.STATIC) continue;
        const segments = ccDebug.body(body);
        parts.push(segments);
        total += segments.vertices.length;
    }

    const positions = new Float32Array(total);
    const colors = new Float32Array(total);
    let offset = 0;
    for (const { vertices, colors: c } of parts) {
        positions.set(vertices, offset);
        colors.set(c, offset);
        offset += vertices.length;
    }

    const geometry = overlay.colliderLines.geometry;
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

// Minimal structural view of a crowd agent — enough to draw its cylinder.
export type CrowdAgentView = { position: ArrayLike<number>; radius: number; height: number };

const CROWD_CIRCLE_SEGMENTS = 16; // resolution of each cylinder's rings
const CROWD_STRUTS = 4; // vertical lines joining the top/bottom rings
// verts per agent: two rings (segment lines) + the vertical struts, each a 2-vert line.
const CROWD_VERTS_PER_AGENT = CROWD_CIRCLE_SEGMENTS * 2 * 2 + CROWD_STRUTS * 2;

// Rebuild the crowd-agent cylinders from the live agents. Agents move every frame, so
// this reruns each frame while enabled; the buffer is reused unless the agent count
// changes. Each agent is a wireframe cylinder: a ring at the feet, a ring at `height`,
// and a few vertical struts — radius = the agent's avoidance radius.
export function updateCrowdDebug(overlay: DebugOverlay, agents: CrowdAgentView[]): void {
    if (!overlay.showCrowd) return;

    const total = agents.length * CROWD_VERTS_PER_AGENT * 3;
    const geometry = overlay.crowdCylinders.geometry;
    let position = geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!position || position.array.length !== total) {
        position = new THREE.BufferAttribute(new Float32Array(total), 3);
        geometry.setAttribute('position', position);
    }
    const buffer = position.array as Float32Array;

    let o = 0;
    const vertex = (x: number, y: number, z: number): void => {
        buffer[o++] = x;
        buffer[o++] = y;
        buffer[o++] = z;
    };

    for (const agent of agents) {
        const cx = agent.position[0];
        const y0 = agent.position[1];
        const cz = agent.position[2];
        const y1 = y0 + agent.height;
        const r = agent.radius;

        for (let i = 0; i < CROWD_CIRCLE_SEGMENTS; i++) {
            const a0 = (i / CROWD_CIRCLE_SEGMENTS) * Math.PI * 2;
            const a1 = ((i + 1) / CROWD_CIRCLE_SEGMENTS) * Math.PI * 2;
            const x0 = cx + Math.cos(a0) * r;
            const z0 = cz + Math.sin(a0) * r;
            const x1 = cx + Math.cos(a1) * r;
            const z1 = cz + Math.sin(a1) * r;
            vertex(x0, y0, z0); // bottom ring segment
            vertex(x1, y0, z1);
            vertex(x0, y1, z0); // top ring segment
            vertex(x1, y1, z1);
        }
        for (let i = 0; i < CROWD_STRUTS; i++) {
            const a = (i / CROWD_STRUTS) * Math.PI * 2;
            const x = cx + Math.cos(a) * r;
            const z = cz + Math.sin(a) * r;
            vertex(x, y0, z); // vertical strut
            vertex(x, y1, z);
        }
    }

    position.needsUpdate = true;
}
