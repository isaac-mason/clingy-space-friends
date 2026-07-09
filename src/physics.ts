import {
    addBroadphaseLayer,
    addObjectLayer,
    type BodyId,
    box,
    capsule,
    createWorld,
    createWorldSettings,
    enableCollision,
    MotionType,
    registerAll,
    rigidBody,
    transformed,
    triangleMesh,
    updateWorld,
    type World,
} from 'crashcat';
import { quat, type Vec3 } from 'mathcat';
import type { Collider } from './collider-schema';
import { FLOOR_HALF_EXTENTS, FLOOR_Y, GRAVITY } from './scene';

// Register all shapes & constraints up front. Simplest during development; swap
// for granular registerShapes/registerConstraints later for better tree-shaking.
registerAll();

const settings = createWorldSettings();

// Earth gravity (shared with the character controller, see scene.ts).
settings.gravity = GRAVITY;

export const BROADPHASE_LAYER_MOVING = addBroadphaseLayer(settings);
export const BROADPHASE_LAYER_NOT_MOVING = addBroadphaseLayer(settings);

export const OBJECT_LAYER_MOVING = addObjectLayer(settings, BROADPHASE_LAYER_MOVING);
export const OBJECT_LAYER_NOT_MOVING = addObjectLayer(settings, BROADPHASE_LAYER_NOT_MOVING);
export const OBJECT_LAYER_GHOST = addObjectLayer(settings, BROADPHASE_LAYER_MOVING);

enableCollision(settings, OBJECT_LAYER_MOVING, OBJECT_LAYER_NOT_MOVING);
enableCollision(settings, OBJECT_LAYER_MOVING, OBJECT_LAYER_MOVING);

export type Physics = {
    world: World;
    /** Maps a rigid-body id → the character id it represents (set on add). Used by the
     *  view ray (see view-ray.ts) to resolve a hit body back to a character. */
    bodyToCharacter: Map<BodyId, string>;
    /** The player's own inner rigid body — excluded from the view ray so we don't
     *  "interact" with ourselves. Set by initCharacter once the KCC exists. */
    playerBodyId: BodyId | null;
};

export function initPhysics(): Physics {
    const world = createWorld(settings);

    rigidBody.create(world, {
        shape: box.create({ halfExtents: FLOOR_HALF_EXTENTS }),
        position: [0, FLOOR_Y, 0],
        motionType: MotionType.STATIC,
        objectLayer: OBJECT_LAYER_NOT_MOVING,
    });

    return { world, bodyToCharacter: new Map(), playerBodyId: null };
}

// Clamp the frame delta so a long pause (e.g. tab refocus) can't blow up the sim.
const MAX_DELTA = 1 / 30;

export function updatePhysics(physics: Physics, dt: number): void {
    updateWorld(physics.world, undefined, Math.min(dt, MAX_DELTA));
}

/**
 * Add the splat scene's collision geometry as a single static triangle-mesh body.
 * Returns the body id — don't hold the body reference, it's pooled (see crashcat README).
 */
export function createSplatCollider(physics: Physics, collider: Collider): BodyId {
    const shape = triangleMesh.create({
        positions: Array.from(collider.positions),
        indices: Array.from(collider.indices),
    });

    const body = rigidBody.create(physics.world, {
        shape,
        motionType: MotionType.STATIC,
        objectLayer: OBJECT_LAYER_NOT_MOVING,
    });

    return body.id;
}

/**
 * Add a kinematic capsule that stands in for a character (companion) in the physics
 * world, so the view ray can hit them. It doesn't collide with anything (GHOST layer)
 * — it exists purely as a raycast target. Records the body→character mapping and
 * returns the body id; move it each frame with moveCharacterCollider.
 *
 * `feet` is the character's ground position; the capsule is offset up to stand on it.
 */
export function addCharacterCollider(physics: Physics, characterId: string, feet: Vec3, radius: number, height: number): BodyId {
    // A capsule's total height is cylinder + a radius hemisphere at each end.
    const halfHeightOfCylinder = Math.max(0.01, height / 2 - radius);
    const shape = transformed.create({
        // Offset the capsule up by half its height so its base sits at the feet.
        shape: capsule.create({ halfHeightOfCylinder, radius }),
        position: [0, height / 2, 0],
        quaternion: quat.create(),
    });

    const body = rigidBody.create(physics.world, {
        shape,
        position: [feet[0], feet[1], feet[2]],
        motionType: MotionType.KINEMATIC,
        objectLayer: OBJECT_LAYER_GHOST,
    });

    physics.bodyToCharacter.set(body.id, characterId);
    return body.id;
}

// Teleport a character's kinematic capsule to follow its ground position. Cheap — we
// only need it in the right place for raycasts, not for swept kinematic collisions.
export function moveCharacterCollider(physics: Physics, bodyId: BodyId, feet: Vec3): void {
    const body = rigidBody.get(physics.world, bodyId);
    if (body) rigidBody.setPosition(physics.world, body, feet, true);
}
