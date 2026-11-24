/*
 * Copyright 2026 Palantir Technologies, Inc. All rights reserved.
 */

// Exercises scripts/submit-comment-with-artifact-links.mjs, which
// scripts/submit-preview-comment.sh runs from the deploy-preview CircleCI job.
// The assertions fail while a commit subject or artifact URL is inserted into the
// GitHub comment body as HTML.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const SCRIPT_DIRECTORY = import.meta.dirname;
const SCRIPT_PATH = join(SCRIPT_DIRECTORY, "submit-comment-with-artifact-links.mjs");
const ARTIFACTS_PATH = join(SCRIPT_DIRECTORY, "artifacts.json");

const ATTACKER_ANCHOR = /<a\b[^>]*href\s*=\s*["']https:\/\/attacker\.example\/preview/i;
const DOCUMENTATION_PATH = "packages/docs-app/dist/index.html";
const SAFE_DOCUMENTATION_URL =
    "https://output.circle-artifacts.com/output/job/abc/artifacts/0/packages/docs-app/dist/index.html";

const ARTIFACT_PATHS = {
    demo: "packages/demo-app/dist/index.html",
    documentation: DOCUMENTATION_PATH,
    landing: "packages/landing-app/dist/index.html",
    storybook: "storybook-static/index.html",
    table: "packages/table-dev-app/dist/index.html",
};

const SUBJECT_WITH_HEADING_BREAKOUT =
    'Fix alignment </h3><a href="https://attacker.example/preview">documentation preview</a> (#8224)';
const SUBJECT_WITH_FENCE_AND_SINGLE_QUOTED_LINK =
    "Preview ```</h3><a href='https://attacker.example/preview'>documentation preview</a>";
const BENIGN_SUBJECT = "Fix alignment for box (#8224)";
const HOSTILE_DOCUMENTATION_URL = `${SAFE_DOCUMENTATION_URL}"></a><a href="https://attacker.example/preview`;

const GITHUB_API_STUB = `
import { writeFileSync } from "node:fs";

const capturePath = process.env.COMMENT_CAPTURE_PATH;
const calls = [];

globalThis.fetch = async (url, options = {}) => {
    const method = options.method || "GET";
    const body = options.body === undefined ? "" : String(options.body);
    calls.push({ url: String(url), method, body });
    writeFileSync(capturePath, JSON.stringify(calls));

    if (String(url).includes("/access_tokens")) {
        return Response.json({
            token: "installation-token-placeholder",
            expires_at: "2099-01-01T00:00:00Z",
        });
    }

    if (method === "POST" && String(url).includes("/comments")) {
        return Response.json({ id: 1, body: "" }, { status: 201 });
    }

    return Response.json({ message: "unhandled test stub request" }, { status: 404 });
};
`;

test("preview comments keep commit subjects and artifact URLs from becoming HTML", () => {
    const privateKeyPem = execFileSync("openssl", ["genrsa", "2048"], { encoding: "utf8" });
    const privateKeyBase64 = Buffer.from(privateKeyPem, "utf8").toString("base64");
    const root = mkdtempSync(join(tmpdir(), "preview-comment-"));
    const previousArtifacts = readOptional(ARTIFACTS_PATH);
    const failures = [];

    try {
        const commitComment = postPreviewComment({
            circleSha: "0123456789abcdef0123456789abcdef01234567",
            documentationUrl: SAFE_DOCUMENTATION_URL,
            privateKeyBase64,
            root,
            subject: SUBJECT_WITH_HEADING_BREAKOUT,
        });
        expectEqual(
            failures,
            commitComment.url,
            "https://api.github.com/repos/palantir/blueprint/commits/0123456789abcdef0123456789abcdef01234567/comments",
        );
        expectSubjectIsText(failures, commitComment.body, SUBJECT_WITH_HEADING_BREAKOUT);
        expectMatch(
            failures,
            commitComment.body.includes(`<a href="${SAFE_DOCUMENTATION_URL}">documentation</a>`),
            "a documentation URL with no HTML metacharacters must stay a preview link",
        );

        const pullRequestComment = postPreviewComment({
            circleSha: "0123456789abcdef0123456789abcdef01234567",
            documentationUrl: SAFE_DOCUMENTATION_URL,
            privateKeyBase64,
            pullRequest: "https://github.com/palantir/blueprint/pull/8224",
            root,
            subject: SUBJECT_WITH_FENCE_AND_SINGLE_QUOTED_LINK,
        });
        expectEqual(
            failures,
            pullRequestComment.url,
            "https://api.github.com/repos/palantir/blueprint/issues/8224/comments",
        );
        expectSubjectIsText(failures, pullRequestComment.body, SUBJECT_WITH_FENCE_AND_SINGLE_QUOTED_LINK);

        const hostileArtifactUrl = postPreviewComment({
            circleSha: "abcdef0123456789abcdef0123456789abcdef01",
            documentationUrl: HOSTILE_DOCUMENTATION_URL,
            privateKeyBase64,
            root,
            subject: BENIGN_SUBJECT,
        });
        expectMatch(
            failures,
            hostileArtifactUrl.body.includes(BENIGN_SUBJECT),
            "benign commit subject must remain in the comment",
        );
        expectNoAttackerAnchor(failures, outsideFences(hostileArtifactUrl.body));
    } finally {
        restoreArtifacts(previousArtifacts);
        rmSync(root, { force: true, recursive: true });
    }

    assert.equal(failures.length, 0, failures.join("\n\n"));
});

function postPreviewComment({ root, privateKeyBase64, subject, circleSha, pullRequest, documentationUrl }) {
    const capturePath = join(root, `capture-${process.hrtime.bigint()}.json`);
    const repo = join(root, `repo-${process.hrtime.bigint()}`);
    const stubPath = join(root, "github-api-stub.mjs");
    writeFileSync(stubPath, GITHUB_API_STUB);
    writeFileSync(ARTIFACTS_PATH, `${JSON.stringify(artifactsDocument(documentationUrl))}\n`);
    commitSubject(repo, subject);

    const env = {
        CIRCLE_SHA1: circleSha,
        COMMENT_CAPTURE_PATH: capturePath,
        GITHUB_APP_ID: "424242",
        GITHUB_APP_INSTALLATION_ID: "4242",
        GITHUB_APP_PRIVATE_KEY: privateKeyBase64,
        HOME: process.env.HOME,
        PATH: process.env.PATH,
    };
    if (pullRequest !== undefined) {
        env.CIRCLE_PULL_REQUEST = pullRequest;
    }

    let stdout = "";
    try {
        stdout = execFileSync(process.execPath, ["--import", pathToFileURL(stubPath).href, SCRIPT_PATH], {
            cwd: repo,
            encoding: "utf8",
            env,
        });
    } catch (error) {
        const stderr = error.stderr ?? "";
        stdout = error.stdout ?? "";
        assert.fail(`preview comment script exited ${error.status}: ${stderr || stdout || error.message}`);
    }

    const calls = JSON.parse(readFileSync(capturePath, "utf8"));
    const commentCall = calls.find(
        call => call.method === "POST" && call.url.includes("/comments") && !call.url.includes("/access_tokens"),
    );
    assert.ok(
        commentCall,
        `script did not post a comment (${calls.map(call => `${call.method} ${call.url}`).join(", ")}). stdout: ${stdout}`,
    );
    const payload = JSON.parse(commentCall.body);
    assert.equal(typeof payload.body, "string");
    return { body: payload.body, url: commentCall.url };
}

function commitSubject(repo, subject) {
    mkdirSync(repo, { recursive: true });
    const git = args => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
    git(["init", "-b", "main"]);
    git(["config", "user.email", "preview-comment-test@example.com"]);
    git(["config", "user.name", "Preview Comment Test"]);
    git(["config", "commit.gpgsign", "false"]);
    writeFileSync(join(repo, "README"), "preview\n");
    git(["add", "README"]);
    git(["commit", "-m", subject]);
    const logged = git(["--no-pager", "log", "--pretty=format:%s", "-1"]).trim();
    assert.equal(logged, subject);
}

function artifactsDocument(documentationUrl) {
    return {
        items: Object.values(ARTIFACT_PATHS).map(path => ({
            path,
            url:
                path === DOCUMENTATION_PATH
                    ? documentationUrl
                    : `https://output.circle-artifacts.com/output/job/abc/artifacts/0/${path}`,
        })),
    };
}

function expectSubjectIsText(failures, body, subject) {
    const outside = outsideFences(body);
    const fenced = fencedRegions(body).some(region => region.includes(subject));
    if (!fenced && outside.includes(subject)) {
        failures.push(`commit subject was inserted as HTML:\n${body}`);
    }
    if (!body.includes("documentation preview")) {
        failures.push(`commit subject text was dropped from the comment:\n${body}`);
    }
    expectNoAttackerAnchor(failures, outside);
}

function expectNoAttackerAnchor(failures, markup) {
    if (ATTACKER_ANCHOR.test(markup)) {
        failures.push(`attacker preview link was inserted as HTML:\n${markup}`);
    }
}

function expectEqual(failures, actual, expected) {
    if (actual !== expected) {
        failures.push(`expected ${expected} but got ${actual}`);
    }
}

function expectMatch(failures, value, message) {
    if (!value) {
        failures.push(message);
    }
}

function outsideFences(markdown) {
    const lines = markdown.split("\n");
    const kept = [];
    let fence = null;
    for (const line of lines) {
        if (fence !== null) {
            if (closesFence(line, fence)) {
                fence = null;
            }
            continue;
        }
        const opened = openingFence(line);
        if (opened !== null) {
            fence = opened;
            continue;
        }
        kept.push(line);
    }
    return kept.join("\n");
}

function fencedRegions(markdown) {
    const lines = markdown.split("\n");
    const regions = [];
    let fence = null;
    let buffer = [];
    for (const line of lines) {
        if (fence !== null) {
            if (closesFence(line, fence)) {
                regions.push(buffer.join("\n"));
                fence = null;
                buffer = [];
            } else {
                buffer.push(line);
            }
            continue;
        }
        const opened = openingFence(line);
        if (opened !== null) {
            fence = opened;
        }
    }
    return regions;
}

function openingFence(line) {
    const match = /^( {0,3})(`{3,}|~{3,})[ \t]*$/.exec(line);
    return match === null ? null : match[2];
}

function closesFence(line, fence) {
    const match = /^( {0,3})(`{3,}|~{3,})[ \t]*$/.exec(line);
    return match !== null && match[2][0] === fence[0] && match[2].length >= fence.length;
}

function readOptional(path) {
    try {
        return readFileSync(path, "utf8");
    } catch (error) {
        if (error.code === "ENOENT") {
            return undefined;
        }
        throw error;
    }
}

function restoreArtifacts(previousContents) {
    if (previousContents === undefined) {
        rmSync(ARTIFACTS_PATH, { force: true });
        return;
    }
    writeFileSync(ARTIFACTS_PATH, previousContents);
}
