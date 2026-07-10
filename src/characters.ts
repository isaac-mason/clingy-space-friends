import type { BodyId } from 'crashcat';
import type { Vec3 } from 'mathcat';

import { addCrowdAgent, makeAgentParams, type Navigation, setAgentTarget, setAgentVelocity, snapToNavMesh } from './navigation';
import { addCharacterCollider, moveCharacterCollider, type Physics } from './physics';

// Emotes a companion can play when the player interacts with them (clip names present
// in every character GLTF). One is picked at random per interaction.
export const EMOTES = ['Yes', 'No', 'Dance'];

// Companions that follow the player around the ship. One distinct model each
// (optimized files in public/characters/<name>.glb, built by pnpm optimize:characters
// from assets/characters/). The visual system (character-visuals.ts) loads these.
export const FOLLOWERS = ['George', 'Leela', 'Mike', 'Stan'];

// --- Follower tuning (world units; this ship is ~human-at-half-scale) ---
const FOLLOW_RADIUS = 0.5; // agent radius navcat keeps between companions
const FOLLOW_HEIGHT = 1.3; // agent height (a bit taller than the ~1m player)
const FOLLOW_SPEED = 1.6; // m/s — a touch quicker than the player so they keep up
const STOP_DISTANCE = 1.2; // hold this far from the player instead of crowding them
const REISSUE_DIST = 0.4; // only re-aim once the player has moved this far (avoids thrash)
const SPAWN_RING = 1.5; // spawn spread around the player
// Below this speed the velocity is mostly jitter, so hold the last heading rather
// than spinning to chase noise.
const FACING_MIN_SPEED = 0.25;

// Data-only companion record. The visual system reads these; it holds no three.js.
export type Character = {
    id: string; // == navcat agent id
    model: string; // which GLTF to draw
    position: Vec3; // feet, world space
    facing: number; // travel-direction yaw (radians)
    speed: number; // m/s (drives idle <-> walk)
    prev: Vec3; // previous position (for velocity)
    target: Vec3; // last follow target issued (re-issue gating)
    collider: BodyId | null; // kinematic capsule following this character (view-ray target)
    emote: string | null; // one-shot emote request; the visual system consumes it
};

export type Characters = {
    list: Character[];
};

export function initCharacters(): Characters {
    return { list: [] };
}

// Create the navcat agents + Character records around the player. Call once after
// the navmesh loads.
export function spawnCharacters(characters: Characters, navigation: Navigation, physics: Physics, playerPos: Vec3): void {
    for (let i = 0; i < FOLLOWERS.length; i++) {
        const angle = (i / FOLLOWERS.length) * Math.PI * 2;
        // Each agent needs its OWN array — navcat stores it by reference.
        const spawn: Vec3 = [
            playerPos[0] + Math.cos(angle) * SPAWN_RING,
            playerPos[1],
            playerPos[2] + Math.sin(angle) * SPAWN_RING,
        ];
        // Snap onto the navmesh; fall back to the player's own spot if the ring
        // point is off-mesh (against a wall, etc.).
        if (!snapToNavMesh(navigation, spawn, spawn)) {
            spawn[0] = playerPos[0];
            spawn[1] = playerPos[1];
            spawn[2] = playerPos[2];
            if (!snapToNavMesh(navigation, spawn, spawn)) continue;
        }

        const params = makeAgentParams(FOLLOW_RADIUS, FOLLOW_HEIGHT, FOLLOW_SPEED);
        const id = addCrowdAgent(navigation, spawn, params);
        if (!id) continue;

        // Kinematic capsule following this character — the view ray's hit target.
        const collider = addCharacterCollider(physics, id, spawn, FOLLOW_RADIUS, FOLLOW_HEIGHT);

        characters.list.push({
            id,
            model: FOLLOWERS[i % FOLLOWERS.length],
            position: [spawn[0], spawn[1], spawn[2]],
            facing: 0,
            speed: 0,
            prev: [spawn[0], spawn[1], spawn[2]],
            target: [spawn[0], spawn[1], spawn[2]],
            collider,
            emote: null,
        });
    }
}

// Request a random emote on the character with the given id (e.g. on interaction).
// The visual system consumes `emote` next frame and plays it once.
export function requestCharacterEmote(characters: Characters, id: string): void {
    const ch = characters.list.find((c) => c.id === id);
    if (ch) ch.emote = EMOTES[Math.floor(Math.random() * EMOTES.length)];
}

// Per-frame: pull each agent's navmesh position/velocity into its Character data,
// then chase the player when far and hold when close. Pure data — no meshes
// touched. Run after the navcat crowd step (navigation.updateCrowd).
export function updateCharacters(
    characters: Characters,
    navigation: Navigation,
    physics: Physics,
    playerPos: Vec3,
    dt: number,
): void {
    for (const ch of characters.list) {
        const agent = navigation.crowd?.agents[ch.id];
        if (!agent) continue;

        const px = agent.position[0];
        const py = agent.position[1];
        const pz = agent.position[2];
        const dx = px - ch.prev[0];
        const dz = pz - ch.prev[2];

        ch.speed = dt > 1e-5 ? Math.hypot(dx, dz) / dt : 0;
        if (ch.speed > FACING_MIN_SPEED) ch.facing = Math.atan2(dx, dz);
        ch.position[0] = px;
        ch.position[1] = py; // navmesh walkable height; good enough for foot placement here
        ch.position[2] = pz;
        ch.prev[0] = px;
        ch.prev[1] = py;
        ch.prev[2] = pz;

        // Keep the raycast capsule glued to the character.
        if (ch.collider !== null) moveCharacterCollider(physics, ch.collider, ch.position);

        // Follow: chase the player while far, hold once inside STOP_DISTANCE so the
        // companions don't jostle the player. Re-issue the target only after the
        // player has actually moved, so navcat isn't re-planning every frame.
        const toPlayer = Math.hypot(playerPos[0] - px, playerPos[2] - pz);
        if (toPlayer > STOP_DISTANCE) {
            const moved = Math.hypot(playerPos[0] - ch.target[0], playerPos[2] - ch.target[2]);
            if (moved > REISSUE_DIST) {
                setAgentTarget(navigation, ch.id, playerPos);
                ch.target[0] = playerPos[0];
                ch.target[1] = playerPos[1];
                ch.target[2] = playerPos[2];
            }
        } else {
            // Arrived near the player — decelerate to a stop and let the next move
            // re-issue a target (target reset to here so REISSUE_DIST triggers).
            setAgentVelocity(navigation, ch.id, [0, 0, 0]);
            ch.target[0] = px;
            ch.target[1] = py;
            ch.target[2] = pz;
        }
    }
}
