import type { Vec3 } from 'mathcat';

// Everything specific to THIS scene's geometry and layout lives here, so swapping
// in a new world is a one-file edit. Retune these to your space; per-system "feel"
// constants stay in their own files.

// --- Assets (served from public/; see the README's asset pipeline) ---
// BASE_URL is '/' in dev and '/<repo>/' for the GitHub Pages build (vite.config.ts),
// so these resolve whether served from the domain root or a project subpath.
const BASE = import.meta.env.BASE_URL;
export const SPLAT_URL = `${BASE}spaceship-lod.rad`;
export const COLLIDER_URL = `${BASE}collider.bin`;
export const NAVMESH_URL = `${BASE}navmesh.json`;

// Collider/navmesh are packed from the hand-authored assets/colliders.glb
// (pnpm build:collider / build:navmesh).
// Collider bounds (world units): x[-22.6, 12.3], y[-1.2, 2.4], z[-18.4, 7.5] → centre ≈ (-5.1, 0.6, -5.5).
export const PROBE_URL = `${BASE}light-probes.json`;

// --- Light-probe grid (baked offline: pnpm bake:probes, or press B in-app) ---
// XZ extent to scatter probe samples over (~the collider bounds). Each sample snaps
// onto the navmesh floor, then lifts to torso height. Shared by the runtime, the
// in-app bake (index.ts), and the offline bake (src/bake.ts).
export const PROBE_MIN_XZ: [number, number] = [-22, -18];
export const PROBE_MAX_XZ: [number, number] = [12, 7];
export const PROBE_SPACING = 1.0; // metres between XZ samples (denser = more local colour)
// Multiple heights above the floor so lighting varies vertically inside a room
// (floor bounce low, ceiling/fixtures high) instead of one probe per room. The
// runtime blends in 3D, so a companion picks up the layer nearest its torso.
export const PROBE_HEIGHTS = [0.4, 1.0, 1.7];
// Keep a probe only if it's within this distance (m) of a collider triangle, so we
// don't waste probes in open volume, far from any surface. This ship is compact —
// everything's within ~1m of a surface — so the useful range is ~0.4-0.9m (lower =
// hug surfaces tighter / fewer probes). The bake logs keep-counts per radius.
export const PROBE_KEEP_RADIUS = 0.8;
// Multiplier on the sampled probe's contribution to the companions' lighting. >1
// makes the ship's local lighting read more strongly on them (the raw irradiance
// is fairly dim). Tune to taste vs the ambient/directional fill.
export const PROBE_INTENSITY = 3.5;

// --- Companion fill lighting (affects the non-splat meshes only; splats are
// self-lit). Balance these against PROBE_INTENSITY: LOWER the fill so the probe's
// coloured, position-varying light carries the look; RAISE it for flatter, safer
// lighting that doesn't depend on the baked grid. ---
export const AMBIENT_INTENSITY = 0.45;
export const HEMI_INTENSITY = 0.3;
export const KEY_LIGHT_INTENSITY = 0.9; // directional key (gives shape/highlights)

// Cap on the renderer device-pixel-ratio. Splats are soft-edged so high DPR buys
// little; capping cuts Spark's per-pixel sort/blend cost on Retina/hi-DPI screens.
export const MAX_DPR = 1.5;

// --- Camera framing (world-space) — used by orbit-mode controls ---
export const CAMERA_POSITION: Vec3 = [-5, 4, 18];
export const CAMERA_TARGET: Vec3 = [-5, 0.6, -5.5];

// --- First-person character ---
// Spawn feet at 0.18 so the eye (feet + EYE_HEIGHT 0.9) sits at y≈1.08.
export const CHARACTER_SPAWN: Vec3 = [-12.55, 0.18, -8.38]; // feet position the player drops in at
export const CHARACTER_LOOK_TARGET: Vec3 = [-5, 1.08, -5.5]; // point the player initially faces (toward ship centre)

// --- Physics ---
export const GRAVITY: Vec3 = [0, -9.81, 0];
export const FLOOR_Y = -5; // kill-plane, below the hull's lowest point (y≈-1.2)
export const FLOOR_HALF_EXTENTS: Vec3 = [40, 0.1, 40]; // catch-plane footprint under the scene
