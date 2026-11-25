/**
 * Spec for scripts/publish-npm-semver-tagged and scripts/get-publishable-paths-from-semver-tags.mjs.
 *
 * A git tag on the commit being published authorizes npm publish only when all of the following hold:
 * the tag matches "<package name>@<version>", that name is the "name" field of a workspace package,
 * that version is the "version" field of the same package, and the package is not private.
 * The publish must be of that package at that version.
 *
 * Any other tag is ignored. It must not select a directory, must not publish, and must not make the
 * script exit non-zero, including when a later package on the same commit is published.
 *
 * These tests fail while tags are trusted as directory names.
 */

import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const root = fileURLToPath(new URL("..", import.meta.url));
const nodeScript = join(root, "scripts/get-publishable-paths-from-semver-tags.mjs");
const publishScript = join(root, "scripts/publish-npm-semver-tagged");

function readManifest(packageDir) {
    const path = join(root, "packages", packageDir, "package.json");
    return JSON.parse(spawnSync("node", ["-e", `process.stdout.write(require("fs").readFileSync(${JSON.stringify(path)}, "utf8"))`], {
        encoding: "utf8",
    }).stdout);
}

const colors = readManifest("colors");
const eslintPlugin = readManifest("eslint-plugin");
const docsApp = readManifest("docs-app");

function git(args, { allowFailure = false } = {}) {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    if (!allowFailure && result.status !== 0) {
        throw new Error(`git ${args.join(" ")} failed (${result.status}): ${result.stderr}`);
    }
    return result;
}

function deleteTag(tag) {
    git(["tag", "-d", tag], { allowFailure: true });
    if (remoteGitDir) {
        spawnSync("git", ["--git-dir", remoteGitDir, "tag", "-d", tag], { encoding: "utf8" });
    }
}

let remoteGitDir;
let originUrl;

function ensureRemote() {
    if (remoteGitDir) {
        return remoteGitDir;
    }
    originUrl = git(["remote", "get-url", "origin"]).stdout.trim();
    remoteGitDir = mkdtempSync(join(tmpdir(), "blueprint-tag-remote-"));
    const cloned = spawnSync("git", ["clone", "--bare", "--local", root, remoteGitDir], { encoding: "utf8" });
    if (cloned.status !== 0) {
        throw new Error(`bare clone failed: ${cloned.stderr}`);
    }
    return remoteGitDir;
}

function useRemote() {
    const bare = ensureRemote();
    git(["remote", "set-url", "origin", bare]);
    return bare;
}

function restoreOrigin() {
    if (originUrl) {
        git(["remote", "set-url", "origin", originUrl], { allowFailure: true });
    }
}

function withLocalTags(tags, fn) {
    for (const tag of tags) {
        deleteTag(tag);
        git(["tag", tag, "HEAD"]);
    }
    try {
        return fn();
    } finally {
        for (const tag of tags) {
            deleteTag(tag);
        }
    }
}

function withRemoteTags(tags, fn) {
    const bare = useRemote();
    const sha = git(["rev-parse", "HEAD"]).stdout.trim();
    try {
        for (const tag of tags) {
            deleteTag(tag);
            const added = spawnSync("git", ["--git-dir", bare, "tag", tag, sha], { encoding: "utf8" });
            if (added.status !== 0) {
                throw new Error(`remote tag ${tag} failed: ${added.stderr}`);
            }
        }
        return fn();
    } finally {
        for (const tag of tags) {
            deleteTag(tag);
        }
        restoreOrigin();
    }
}

function listPaths() {
    const result = spawnSync(process.execPath, [nodeScript], { cwd: root, encoding: "utf8" });
    const paths = result.stdout
        .split("\n")
        .map(line => line.trim())
        .filter(line => line.length > 0);
    return { result, paths };
}

function assertPaths(tags, expected) {
    withLocalTags(tags, () => {
        const { result, paths } = listPaths();
        assert.equal(
            result.status,
            0,
            `exit ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
        );
        assert.deepEqual(paths.sort(), [...expected].sort());
    });
}

function listen() {
    const publishes = [];
    const server = createServer((request, response) => {
        const chunks = [];
        request.on("data", chunk => chunks.push(chunk));
        request.on("end", () => {
            const body = Buffer.concat(chunks);
            if (request.method === "PUT") {
                let parsed;
                try {
                    parsed = JSON.parse(body.toString("utf8"));
                } catch (error) {
                    publishes.push({ parseError: String(error), url: request.url });
                    response.writeHead(500, { "content-type": "application/json" });
                    response.end(JSON.stringify({ error: "test registry could not parse the publish body" }));
                    return;
                }
                publishes.push({
                    name: parsed.name,
                    version: parsed["dist-tags"] && Object.values(parsed["dist-tags"])[0],
                    distTags: parsed["dist-tags"],
                    url: request.url,
                });
                const conflict = publishes.filter(item => item.name === parsed.name).length > 1;
                if (server.rejectNames.has(parsed.name) || conflict) {
                    response.writeHead(409, { "content-type": "application/json" });
                    response.end(JSON.stringify({ error: "conflict" }));
                    return;
                }
                response.writeHead(201, { "content-type": "application/json" });
                response.end(JSON.stringify({ ok: true }));
                return;
            }
            response.writeHead(404, { "content-type": "application/json" });
            response.end(JSON.stringify({ error: "missing" }));
        });
    });
    server.rejectNames = new Set();
    return new Promise(resolve => {
        server.listen(0, "127.0.0.1", () => {
            const { port } = server.address();
            resolve({
                server,
                port,
                publishes,
                close: () =>
                    new Promise((closeResolve, closeReject) => {
                        server.close(error => (error ? closeReject(error) : closeResolve()));
                    }),
            });
        });
    });
}

function runPublish(env) {
    const registryCheck = spawnSync("pnpm", ["config", "get", "registry"], {
        cwd: root,
        env,
        encoding: "utf8",
    });
    const configured = registryCheck.stdout.trim();
    if (!configured.startsWith("http://127.0.0.1:")) {
        throw new Error(`refusing to run publish; pnpm registry is ${configured || registryCheck.stderr}`);
    }
    return spawnSync(publishScript, [], { cwd: root, env, encoding: "utf8" });
}

async function publishWith(tags, { branch, rejectNames = [] } = {}) {
    const registry = await listen();
    registry.rejectNames = new Set(rejectNames);
    const env = {
        ...process.env,
        CIRCLECI: "true",
        CIRCLE_BRANCH: branch,
        pnpm_config_registry: `http://127.0.0.1:${registry.port}`,
        // The publish script must not be handed a registry token.
        NPM_ID_TOKEN: "",
    };
    try {
        const result = withRemoteTags(tags, () => runPublish(env));
        return { result, publishes: registry.publishes };
    } finally {
        await registry.close();
    }
}

describe("semver tag publish", { concurrency: false }, () => {
    test("a tag whose package name and version match the manifest is publishable", () => {
        assertPaths([`${colors.name}@${colors.version}`], ["packages/colors"]);
    });

    test("a private package is not publishable when its tag matches the manifest", () => {
        assert.equal(docsApp.private, true);
        assertPaths([`${docsApp.name}@${docsApp.version}`], []);
    });

    test("an unknown package tag is ignored and does not drop a package whose tag matches", () => {
        assertPaths([`${colors.name}@${colors.version}`, "nope@1.0.0"], ["packages/colors"]);
    });

    test("a tag version that is not the manifest version does not select that package", () => {
        assertPaths([`${colors.name}@0.0.0-not-the-manifest`], []);
    });

    test("a tag that only matches the directory's last segment does not select that package", () => {
        assertPaths([`colors@${colors.version}`], []);
    });

    test("a tag whose scope is not the manifest name does not select that directory", () => {
        assertPaths([`@evil/colors@${colors.version}`], []);
    });

    test("an unknown tag fetched from the remote does not fail the publish or suppress the matching package", async () => {
        const { result, publishes } = await publishWith([`${colors.name}@${colors.version}`, "nope@1.0.0"], {
            branch: "develop",
        });
        assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
        assert.deepEqual(
            publishes.map(item => ({ name: item.name, version: item.version })),
            [{ name: colors.name, version: colors.version }],
        );
    });

    test("a tag for a missing package is ignored when nothing else is tagged", async () => {
        const { result, publishes } = await publishWith(["nope@1.0.0"], { branch: "develop" });
        assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
        assert.deepEqual(publishes, []);
    });

    test("a directory tag whose version is not the manifest does not publish and does not block the matching package", async () => {
        const { result, publishes } = await publishWith(
            [`${colors.name}@${colors.version}`, `eslint-plugin@0.0.0`],
            { branch: "develop", rejectNames: [eslintPlugin.name] },
        );
        assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
        assert.deepEqual(
            publishes.map(item => item.name),
            [colors.name],
        );
        assert.equal(publishes[0].version, colors.version);
        assert.equal(publishes[0].distTags.latest, colors.version);
    });

    test("every manifest-matching tag is published, on develop and on a release branch", async () => {
        for (const branch of ["develop", "release/6.x"]) {
            const { result, publishes } = await publishWith(
                [`${colors.name}@${colors.version}`, `${eslintPlugin.name}@${eslintPlugin.version}`],
                { branch },
            );
            assert.equal(result.status, 0, `${branch}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
            assert.deepEqual(
                publishes.map(item => `${item.name}@${item.version}`).sort(),
                [`${colors.name}@${colors.version}`, `${eslintPlugin.name}@${eslintPlugin.version}`].sort(),
            );
            for (const item of publishes) {
                assert.equal(item.distTags.latest, item.version);
            }
        }
    });

    test("the next branch publishes only the manifest-matching package and records the next dist-tag", async () => {
        const { result, publishes } = await publishWith([`${colors.name}@${colors.version}`, "nope@1.0.0"], {
            branch: "next",
        });
        assert.equal(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
        assert.deepEqual(publishes.map(item => item.name), [colors.name]);
        assert.equal(publishes[0].version, colors.version);
        assert.equal(publishes[0].distTags.next, colors.version);
    });
});

process.on("exit", () => {
    restoreOrigin();
    if (remoteGitDir) {
        rmSync(remoteGitDir, { recursive: true, force: true });
    }
});
