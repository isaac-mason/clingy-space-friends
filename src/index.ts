import { SparkRenderer, SplatMesh } from '@sparkjsdev/spark';
import type { Vec3 } from 'mathcat';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import { EYE_HEIGHT, initCharacter, updateCharacter } from './character';
import { initCharacterVisuals, loadCharacterVisuals, updateCharacterVisuals } from './character-visuals';
import { initCharacters, requestCharacterEmote, spawnCharacters, updateCharacters } from './characters';
import { type Collider, unpackCollider } from './collider-schema';
import { getMoveDirection, initFirstPersonControls, releaseFirstPersonControls, updateFirstPersonCamera } from './controls';
import { createCrosshair, setCrosshairVisible, setInteractHint } from './crosshair';
import { buildColliderDebug, buildProbeDebug, createDebugOverlay, updateCrowdDebug, updateDebugOverlay } from './debug';
import { deserializeProbeGrid, type ProbeGrid, sampleProbeGrid } from './light-probes';
import { addPlayerAgent, initNavigation, loadNavigation, updateCrowd, updateNavigation, updatePlayerAgent } from './navigation';
import { applyPerformance, initPerformance } from './performance';
import { createSplatCollider, initPhysics, updatePhysics } from './physics';
import {
    AMBIENT_INTENSITY,
    CAMERA_POSITION,
    CAMERA_TARGET,
    COLLIDER_URL,
    HEMI_INTENSITY,
    KEY_LIGHT_INTENSITY,
    PROBE_INTENSITY,
    PROBE_URL,
    SPLAT_URL,
} from './scene';
import { castViewRay } from './view-ray';
import './style.css';

function init() {
    const scene = new THREE.Scene();

    // Neutral fill for the companions (splats are self-lit and ignore these).
    // Intensities live in scene.ts to balance against PROBE_INTENSITY in one place.
    scene.add(new THREE.AmbientLight(0xffffff, AMBIENT_INTENSITY));
    const hemi = new THREE.HemisphereLight(0xbfd4ff, 0x202028, HEMI_INTENSITY);
    scene.add(hemi);
    // Key light — gives the companions shape/highlights the flat probe irradiance
    // can't. Angled from above-front; warm to read as ship interior lighting.
    const keyLight = new THREE.DirectionalLight(0xfff0dc, KEY_LIGHT_INTENSITY);
    keyLight.position.set(4, 10, 4);
    scene.add(keyLight);

    // Runtime irradiance probe fed each frame from the baked probe grid
    // (public/light-probes.json) — lights the companions with the ship's local
    // lighting. The grid is baked offline (pnpm bake:probes); the app only reads it.
    const envProbe = new THREE.LightProbe();
    envProbe.intensity = PROBE_INTENSITY;
    scene.add(envProbe);

    // Near plane kept well inside the character's HEAD_CLEARANCE so the ceiling never
    // enters the near plane on a jump (otherwise it gets clipped and you see through it).
    const CAMERA_NEAR = 0.05;
    const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, CAMERA_NEAR, 1000);
    camera.position.set(CAMERA_POSITION[0], CAMERA_POSITION[1], CAMERA_POSITION[2]);

    // antialias: false is recommended for Spark — MSAA doesn't help splats and costs perf.
    const renderer = new THREE.WebGLRenderer({ antialias: false });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
    const app = document.querySelector<HTMLDivElement>('#app') ?? document.body;
    app.appendChild(renderer.domElement);

    // SparkRenderer drives splat sorting and LOD streaming/updates for the .rad file.
    // Widen the LOD foveation cone so splats near the screen corners stay full-res
    // (defaults: coneFov0 90, coneFov 120, coneFoveate 0.4).
    const spark = new SparkRenderer({
        renderer,
        coneFov0: 120,
        coneFov: 160,
        coneFoveate: 0.5,
    });
    scene.add(spark);

    const splat = new SplatMesh({ url: encodeURI(SPLAT_URL) });
    scene.add(splat);

    // Orbit camera — used only in the debug "orbit camera" mode; starts disabled
    // so the first-person controller drives the camera by default.
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.target.set(CAMERA_TARGET[0], CAMERA_TARGET[1], CAMERA_TARGET[2]);
    controls.enabled = false;
    controls.update();

    // Runtime perf/quality settings (LOD budget, …); the debug panel tweaks these.
    const perf = initPerformance();

    // Debug panel: toggle with the backtick (`) key. Orbit/character mode toggle,
    // collider/navmesh wireframes, LOD slider, and a readout.
    const debug = createDebugOverlay(perf);
    scene.add(debug.colliderLines);
    scene.add(debug.crowdCylinders);

    const physics = initPhysics();

    const navigation = initNavigation();

    // First-person character: a KCC capsule the player walks around the ship with,
    // plus pointer-lock mouse look + WASD. Click the canvas to capture the mouse.
    const character = initCharacter(physics);
    const fp = initFirstPersonControls(camera, renderer.domElement);

    // Companions: a navcat crowd of animated GLTF characters that follow the player.
    const characters = initCharacters();
    const characterVisuals = initCharacterVisuals(scene);

    // HUD crosshair + "interact" hint (shown when looking at a companion).
    const crosshair = createCrosshair();

    window.addEventListener('resize', () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    });

    return {
        scene,
        camera,
        renderer,
        spark,
        splat,
        controls,
        perf,
        debug,
        physics,
        navigation,
        character,
        characters,
        characterVisuals,
        crosshair,
        envProbe,
        fp,
        orbitActive: false, // tracks debug.orbitMode to detect mode switches
        collider: null as Collider | null,
        probeGrid: null as ProbeGrid | null,
    };
}

type State = ReturnType<typeof init>;

async function loadCollider(url: string): Promise<Collider> {
    const res = await fetch(url);
    if (!res.ok) {
        throw new Error(`Failed to load collider (${res.status}): ${url}`);
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    return unpackCollider(bytes);
}

async function load(state: State) {
    // Wait for the splat to finish downloading/decoding before the first frame.
    await state.splat.initialized;

    state.collider = await loadCollider(COLLIDER_URL);
    console.log(`collider loaded: ${state.collider.positions.length / 3} verts, ${state.collider.indices.length / 3} tris`);

    // Add the scene geometry to the physics world as a static triangle mesh.
    createSplatCollider(state.physics, state.collider);

    // Colliders never move — build the debug wireframe once, now that they exist.
    buildColliderDebug(state.debug, state.physics.world);

    await loadNavigation(state.navigation);

    // Load the companion models, then spawn the crowd around the player's spawn.
    await loadCharacterVisuals(state.characterVisuals);
    const p = state.character.kcc.position;
    spawnCharacters(state.characters, state.navigation, state.physics, [p[0], p[1], p[2]]);

    // Represent the player in the crowd so companions avoid us like any other agent.
    addPlayerAgent(state.navigation, [p[0], p[1], p[2]]);

    // Load the precomputed probe grid if present (baked offline: pnpm bake:probes).
    // Without it the companions just use the fill lights.
    try {
        const res = await fetch(PROBE_URL);
        if (res.ok) {
            state.probeGrid = deserializeProbeGrid(await res.text());
            buildProbeDebug(state.debug, state.scene, state.probeGrid);
            console.log(`probe grid: loaded ${state.probeGrid.positions.length} probes from light-probes.json`);
        }
    } catch {
        // no probe file yet — fine, run a dev bake (press B) to create one
    }
}

const _moveDir: Vec3 = [0, 0, 0];
const _playerPos: Vec3 = [0, 0, 0];
const _probeColor = new THREE.Color();
const INTERACT_RANGE = 2; // metres — how far the interaction view ray reaches
const SH_Y00 = 0.28209479; // DC SH coeff -> average radiance colour (for the readout)

const _orbitDir = new THREE.Vector3();
const ORBIT_PULLBACK = 5; // metres to pull the orbit camera back off the character's head

// Apply a switch between first-person and orbit camera modes (driven by the debug
// panel's "orbit camera" checkbox).
function syncCameraMode(state: State) {
    if (state.debug.orbitMode === state.orbitActive) return;
    state.orbitActive = state.debug.orbitMode;

    if (state.orbitActive) {
        // → orbit: release the mouse and orbit around the character's head. Pull the
        // camera back along its current look direction first — otherwise it sits ON
        // the target (zero radius) and OrbitControls has nothing to orbit around.
        state.fp.enabled = false;
        releaseFirstPersonControls(state.fp);
        const f = state.character.kcc.position;
        state.controls.target.set(f[0], f[1] + EYE_HEIGHT, f[2]);
        state.camera.getWorldDirection(_orbitDir);
        state.camera.position.copy(state.controls.target).addScaledVector(_orbitDir, -ORBIT_PULLBACK);
        state.controls.enabled = true;
        state.controls.update();
    } else {
        // → first-person: OrbitControls off, character drives the camera again.
        state.controls.enabled = false;
        state.fp.enabled = true;
    }
}

function update(state: State, dt: number, _time: number) {
    syncCameraMode(state);

    // Pin the player's proxy agent to us BEFORE the crowd steps, so companions steer
    // around where we are and where we're heading.
    updatePlayerAgent(state.navigation, state.character.kcc.position, state.character.kcc.linearVelocity);
    updateCrowd(state.navigation, dt);

    // Step the character first (sweeps against the world), then the dynamics, then
    // follow with the camera — mirrors crashcat's example ordering.
    if (state.fp.enabled) {
        getMoveDirection(state.fp, _moveDir);
        updateCharacter(state.physics, state.character, _moveDir, state.fp.input.jump, state.fp.input.sprint, dt);
    }
    updatePhysics(state.physics, dt);

    // Companions follow the player: feed the crowd the player's current feet
    // position, then sync the animated models to the resulting agent motion.
    const pf = state.character.kcc.position;
    _playerPos[0] = pf[0];
    _playerPos[1] = pf[1];
    _playerPos[2] = pf[2];
    updateCharacters(state.characters, state.navigation, state.physics, _playerPos, dt);
    updateCharacterVisuals(state.characterVisuals, state.characters.list, dt);

    // Crowd debug: draw a cylinder per live agent (companions + the player proxy).
    if (state.debug.showCrowd && state.navigation.crowd) {
        updateCrowdDebug(state.debug, Object.values(state.navigation.crowd.agents));
    }

    // Light the companions from the baked probe grid, sampled in 3D at their
    // centroid + torso height (they cluster near the player, so one group probe
    // reads correctly).
    if (state.probeGrid) {
        let cx = 0;
        let cy = 0;
        let cz = 0;
        const list = state.characters.list;
        for (const ch of list) {
            cx += ch.position[0];
            cy += ch.position[1];
            cz += ch.position[2];
        }
        if (list.length > 0) {
            cx /= list.length;
            cy /= list.length;
            cz /= list.length;
        } else {
            cx = _playerPos[0];
            cy = _playerPos[1];
            cz = _playerPos[2];
        }
        sampleProbeGrid(state.probeGrid, cx, cy + 0.65, cz, state.envProbe); // +torso height
    }

    if (state.fp.enabled) {
        updateFirstPersonCamera(state.fp, state.character, dt);
    } else {
        state.controls.update();
    }

    // Interaction: in first-person, cast a view ray from the camera. If it lands on a
    // companion, show the "interact" hint; pressing E makes them play a random emote.
    if (state.fp.enabled) {
        const hovered = castViewRay(state.physics, state.camera, INTERACT_RANGE);
        setInteractHint(state.crosshair, hovered !== null);
        const pressed = state.fp.input.interact;
        state.fp.input.interact = false; // consume the one-shot press
        if (pressed && hovered) requestCharacterEmote(state.characters, hovered);
    }
    setCrosshairVisible(state.crosshair, state.fp.enabled);

    // Push runtime perf settings (LOD budget, …) onto the renderer.
    applyPerformance(state.perf, state.spark);
    // Feed the debug readout the lighting the companions are actually getting: the
    // sampled scene probe's average (DC) radiance colour.
    const c0 = state.envProbe.sh.coefficients[0];
    _probeColor.setRGB(Math.max(0, c0.x) * SH_Y00, Math.max(0, c0.y) * SH_Y00, Math.max(0, c0.z) * SH_Y00);
    updateDebugOverlay(state.debug, state.camera, state.character, state.spark, {
        count: state.probeGrid?.positions.length ?? 0,
        color: _probeColor,
    });
    updateNavigation(state.navigation, state.scene, state.debug.showNavMesh);
    state.renderer.render(state.scene, state.camera);
}

// Fade out + remove the loading overlay once everything's ready.
function hideLoading() {
    const el = document.getElementById('loading');
    if (!el) return;
    el.classList.add('hidden');
    setTimeout(() => el.remove(), 700); // after the CSS fade
}

// `splat.initialized` only means the file is decoded — the splats aren't on
// screen until Spark has sorted them and streamed in the LOD pages. The render
// loop drives that, and `spark.activeSplats` climbs from 0 as splats become
// renderable. So we run the loop with the overlay still up and lift it once that
// count crosses a fraction of the model's total. Expressed as a fraction (not a
// raw count) so it scales if the asset changes; timeout is a backstop in case
// frustum culling / LOD plateaus the count below the threshold.
const SPLAT_READY_FRACTION = 0.8; // lift once this share of the model's splats are rendered
const SPLAT_WAIT_TIMEOUT_MS = 10000; // ... but never keep the loader up longer than this

async function start() {
    const state = init();
    await load(state);

    let lastTime = performance.now();
    let elapsed = 0;

    let loaderUp = true;
    const startedAt = performance.now();

    function loop() {
        const now = performance.now();
        const dt = (now - lastTime) / 1000;
        lastTime = now;
        elapsed += dt;
        update(state, dt, elapsed); // renders the frame, which drives Spark's sort + LOD streaming

        if (loaderUp) {
            const active = state.spark.activeSplats;
            const total = state.splat.numSplats;
            const ready = total > 0 && active >= total * SPLAT_READY_FRACTION;
            if (ready || now - startedAt >= SPLAT_WAIT_TIMEOUT_MS) {
                loaderUp = false;
                console.log(`splats ready: ${active}/${total} active${ready ? '' : ' (timed out)'}`);
                hideLoading();
            }
        }

        requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);
}

start();
