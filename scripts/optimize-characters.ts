/**
 * Optimize the textured character models for the web.
 *
 * The source models (assets/characters/*.gltf) ship a 2048² PNG texture atlas
 * each — ~2 MB of the ~3 MB per model. That's overkill for ~1 m-tall companions
 * viewed in a small scene. This runs a gltf-transform pipeline that:
 *   - dedup()          merge duplicate accessors/textures/materials
 *   - prune()          drop unused nodes/data
 *   - resample()       remove redundant animation keyframes
 *   - textureCompress()resize the atlas to TEXTURE_SIZE and re-encode as WebP
 *                      (the big win — Three's GLTFLoader reads EXT_texture_webp
 *                      natively, no runtime loader needed)
 *   - meshopt()        EXT_meshopt_compression on geometry + animation (needs the
 *                      MeshoptDecoder wired into the loader — see character-visuals.ts)
 * and writes a single self-contained .glb per model to public/characters/.
 *
 * Usage:
 *   pnpm optimize:characters [inputDir] [outputDir]
 */
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { type Document, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, meshopt, prune, resample, textureCompress } from '@gltf-transform/functions';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';
import sharp from 'sharp';

const INPUT_DIR = process.argv[2] ?? 'assets/characters';
const OUTPUT_DIR = process.argv[3] ?? 'public/characters';

// Max texture atlas dimension after resize. The companions are ~1 m tall and never
// fill much of the screen, so 1024 keeps them crisp; drop to 512 for a smaller build.
const TEXTURE_SIZE = 1024;
// WebP quality (0-100). 80 is visually lossless for these stylized atlases.
const TEXTURE_QUALITY = 80;

const MB = (bytes: number) => `${(bytes / 1e6).toFixed(2)} MB`;

// The source models are authored unlit (KHR_materials_unlit) — they'd ignore the
// scene's light probes and never receive shadows. Strip the extension so they load
// as MeshStandardMaterial and pick up the ship's baked lighting. metalness=0 /
// roughness=1 gives a fully diffuse, matte response (no specular on stylized art).
function delit(document: Document): void {
    for (const mat of document.getRoot().listMaterials()) {
        if (mat.getExtension('KHR_materials_unlit')) {
            mat.setExtension('KHR_materials_unlit', null);
            mat.setMetallicFactor(0);
            mat.setRoughnessFactor(1);
        }
    }
    // Detaching the property leaves the Extension registered on the document
    // (still listed in extensionsUsed); dispose it so it drops from the output.
    for (const ext of document.getRoot().listExtensionsUsed()) {
        if (ext.extensionName === 'KHR_materials_unlit') ext.dispose();
    }
}

async function main() {
    await MeshoptEncoder.ready;
    await MeshoptDecoder.ready;

    const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
        'meshopt.encoder': MeshoptEncoder,
        'meshopt.decoder': MeshoptDecoder,
    });

    const inputDir = resolve(INPUT_DIR);
    const outputDir = resolve(OUTPUT_DIR);
    await mkdir(outputDir, { recursive: true });

    const files = (await readdir(inputDir)).filter((f) => /\.(gltf|glb)$/i.test(f)).sort();
    if (files.length === 0) throw new Error(`No .gltf/.glb models found in ${INPUT_DIR}`);

    let totalIn = 0;
    let totalOut = 0;
    for (const file of files) {
        const name = basename(file, extname(file));
        const inPath = join(inputDir, file);
        const outPath = join(outputDir, `${name}.glb`);

        const doc = await io.read(inPath);
        await doc.transform(
            delit,
            dedup(),
            prune(),
            resample(),
            textureCompress({
                encoder: sharp,
                targetFormat: 'webp',
                resize: [TEXTURE_SIZE, TEXTURE_SIZE],
                quality: TEXTURE_QUALITY,
            }),
            meshopt({ encoder: MeshoptEncoder, level: 'high' }),
        );

        const bytes = await io.writeBinary(doc);
        await writeFile(outPath, bytes);

        const inBytes = (await stat(inPath)).size;
        const outBytes = bytes.byteLength;
        totalIn += inBytes;
        totalOut += outBytes;
        const pct = ((1 - outBytes / inBytes) * 100).toFixed(0);
        console.log(`${name}: ${MB(inBytes)} -> ${MB(outBytes)} (-${pct}%)  ${outPath}`);
    }

    const pct = ((1 - totalOut / totalIn) * 100).toFixed(0);
    console.log(`\nTotal: ${MB(totalIn)} -> ${MB(totalOut)} (-${pct}%) across ${files.length} models`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
