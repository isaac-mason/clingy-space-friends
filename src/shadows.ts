import * as THREE from 'three';

import type { Collider } from './collider-schema';
import { KEY_LIGHT_INTENSITY } from './scene';

// Real-time shadows for the companions. Ported from lively-crossing: the splats
// are self-lit and render outside Three's material pipeline, so they can't receive
// (or cast) real shadow maps. The trick is a three-part setup:
//   1. One directional "key/sun" light casts into a shadow map.
//   2. Only the character meshes cast (set in character-visuals.ts).
//   3. The collision mesh — invisible, a ShadowMaterial overlay — RECEIVES the
//      shadows and paints them on top of the splats (attachShadowCatcher).
// The shadow frustum follows the player so texels stay dense where the action is.

// Shadow map resolution. The ship interior is compact, so 2048 gives crisp
// character shadows without needing to blanket a large area.
const SHADOW_MAP_SIZE = 2048;

// Half-width (world metres) of the orthographic shadow frustum around the followed
// point. Only the player + nearby companions cast, so a tight frustum keeps the
// texels dense and the shadows sharp; 15 still leaves margin for a trailing follower.
const SHADOW_HALF_EXTENT = 15;

// Key light offset from the followed point. Colinear with the old static key light
// direction (4,10,4) so the companions' shape lighting is UNCHANGED — only the
// shadow camera rides along. High up so the frustum clears the ceiling.
const SUN_OFFSET = new THREE.Vector3(8, 20, 8);

// ShadowMaterial overlay opacity on the (invisible) collision mesh. Keep it subtle
// so it grounds the companions without darkening the splats' baked look.
const SHADOW_CATCHER_OPACITY = 0.3;
// Draw the catcher in the transparent pass AFTER the splats so its shadows overlay
// them instead of being sorted behind.
const SHADOW_CATCHER_RENDER_ORDER = 1000;

export type Shadows = { sun: THREE.DirectionalLight };

// Enable shadow mapping and create the shadow-casting key light. Replaces the old
// static keyLight in index.ts — same colour/intensity, so lighting is unchanged;
// it now also casts shadows and is repositioned each frame by updateShadows.
export function initShadows(scene: THREE.Scene, renderer: THREE.WebGLRenderer): Shadows {
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    const sun = new THREE.DirectionalLight(0xfff0dc, KEY_LIGHT_INTENSITY);
    sun.position.copy(SUN_OFFSET); // overwritten each frame by updateShadows
    sun.castShadow = true;
    sun.shadow.mapSize.set(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE);
    sun.shadow.bias = -0.0005; // pull shadows back to kill acne on the near-flat floor
    sun.shadow.normalBias = 0.02;

    const cam = sun.shadow.camera; // OrthographicCamera
    cam.near = 1;
    cam.far = SUN_OFFSET.length() + SHADOW_HALF_EXTENT * 2; // reach from the light down past the floor
    cam.left = cam.bottom = -SHADOW_HALF_EXTENT;
    cam.right = cam.top = SHADOW_HALF_EXTENT;
    cam.updateProjectionMatrix();

    scene.add(sun);
    scene.add(sun.target); // a directional light aims at its target; we follow the player

    return { sun };
}

// Build an invisible receiver mesh from the same world-space triangle soup the
// physics collider uses, so shadows land exactly on the walkable geometry (and thus
// where the splats are). ShadowMaterial renders nothing but the received shadows.
export function attachShadowCatcher(scene: THREE.Scene, collider: Collider): void {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(collider.positions, 3));
    geometry.setIndex(new THREE.BufferAttribute(collider.indices, 1));
    geometry.computeVertexNormals(); // ShadowMaterial + normalBias need vertex normals

    const mat = new THREE.ShadowMaterial({ opacity: SHADOW_CATCHER_OPACITY });
    mat.depthWrite = false; // don't punch a hole in the splats behind the overlay

    const mesh = new THREE.Mesh(geometry, mat);
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    mesh.renderOrder = SHADOW_CATCHER_RENDER_ORDER;
    mesh.frustumCulled = false; // one whole-ship mesh; nothing to gain from culling it
    scene.add(mesh);
}

// Re-centre the shadow frustum on the followed point (the player's feet) each frame,
// keeping the light DIRECTION fixed so only the shadow camera moves.
export function updateShadows(shadows: Shadows, x: number, y: number, z: number): void {
    shadows.sun.position.set(x + SUN_OFFSET.x, y + SUN_OFFSET.y, z + SUN_OFFSET.z);
    shadows.sun.target.position.set(x, y, z);
    shadows.sun.target.updateMatrixWorld();
}
