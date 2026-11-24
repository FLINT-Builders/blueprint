#!/usr/bin/env node
/*
 * Copyright 2017 Palantir Technologies, Inc. All rights reserved.
 */

// @ts-check
/* eslint-disable camelcase */

// Submits a comment to the change PR or commit with links to artifacts that
// show the results of the code change being applied.
//
// Authentication is done via a GitHub App. The following environment variables are required:
//   - GITHUB_APP_ID: The App ID from the GitHub App settings page
//   - GITHUB_APP_PRIVATE_KEY: The full private key (.pem) contents from the key generated on the GitHub App settings page
//   - GITHUB_APP_INSTALLATION_ID: The installation ID (visible in the URL after installing the app on the repo)
//
// See https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app

import { execFileSync } from "node:child_process";
import { basename } from "node:path";
import { App } from "octokit";

/**
 * @type {Array<{path: string; url: string;}>}
 */
const { default: artifacts } = await import("./artifacts.json", { with: { type: "json" } });

if (artifacts.items === undefined) {
    throw new Error(
        "Unable to read artifacts.json, please make sure the CircleCI API call succeeded with the necessary personal access token.",
    );
}

const ARTIFACTS = {
    documentation: "packages/docs-app/dist/index.html",
    landing: "packages/landing-app/dist/index.html",
    table: "packages/table-dev-app/dist/index.html",
    demo: "packages/demo-app/dist/index.html",
    storybook: "storybook-static/index.html",
};

/** @param {string} value */
function escapeHtml(value) {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

/**
 * Renders untrusted text as a fenced code block so GitHub does not interpret it as HTML or Markdown.
 * The fence is longer than any backtick run in the text, so the text cannot close it.
 *
 * @param {string} text
 */
function toFencedCodeBlock(text) {
    const singleLine = text.replace(/[\r\n]+/g, " ");
    const longestBacktickRun = Math.max(0, ...(singleLine.match(/`+/g) ?? []).map(run => run.length));
    const fence = "`".repeat(Math.max(3, longestBacktickRun + 1));
    return `${fence}\n${singleLine}\n${fence}`;
}

function getArtifactAnchorLink(pkg) {
    const artifactInfo = artifacts.items.find(a => a.path === ARTIFACTS[pkg]);
    let url;
    try {
        url = new URL(artifactInfo?.url);
    } catch {
        return pkg;
    }
    if (url.protocol !== "https:") {
        return pkg;
    }
    return `<a href="${escapeHtml(url.href)}">${pkg}</a>`;
}

if (process.env.GITHUB_APP_ID && process.env.GITHUB_APP_PRIVATE_KEY && process.env.GITHUB_APP_INSTALLATION_ID) {
    // Authenticate as a GitHub App to post PR comments.
    // See https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app#using-the-octokitjs-sdk-to-authenticate-as-a-github-app
    const app = new App({
        appId: process.env.GITHUB_APP_ID,
        privateKey: Buffer.from(process.env.GITHUB_APP_PRIVATE_KEY, "base64").toString("utf8"),
    });
    const octokit = await app.getInstallationOctokit(Number(process.env.GITHUB_APP_INSTALLATION_ID));

    const artifactLinks = Object.keys(ARTIFACTS).map(getArtifactAnchorLink).join(" | ");
    const currentGitCommitMessage = execFileSync("git", ["--no-pager", "log", "--pretty=format:%s", "-1"])
        .toString()
        .trim();
    // The commit subject is author-controlled, so it must never be interpolated as markup
    // (and must not pass through dedent, which rewrites escape sequences in its input).
    const commentBody = [
        "**Latest commit:**",
        toFencedCodeBlock(currentGitCommitMessage),
        "",
        `Build artifact links for this commit: <strong>${artifactLinks}</strong>`,
        "",
        "<em>This is an automated comment from the deploy-preview CircleCI job.</em>",
    ].join("\n");

    const repoParams = {
        owner: "palantir",
        repo: "blueprint",
    };

    if (process.env.CIRCLE_PULL_REQUEST) {
        // attempt to comment on the PR as an "issue comment" (not a review comment)
        await octokit.rest.issues.createComment({
            ...repoParams,
            issue_number: parseInt(basename(process.env.CIRCLE_PULL_REQUEST ?? ""), 10),
            body: commentBody,
        });
    } else if (process.env.CIRCLE_SHA1) {
        // attempt to comment on the commit if there is no associated PR (this is most useful on the develop branch)
        await octokit.rest.repos.createCommitComment({
            ...repoParams,
            commit_sha: process.env.CIRCLE_SHA1,
            body: commentBody,
        });
    }
} else {
    // If the GitHub App credentials are missing, simply log artifact URLs (typical in builds on repository forks).
    console.warn(
        "GitHub App credentials not available, so we cannot post a preview comment on this build's PR. This is expected on forks which have enabled CircleCI building.",
    );
    console.warn("Required environment variables: GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, GITHUB_APP_INSTALLATION_ID");
    Object.keys(ARTIFACTS).forEach(pkg => console.info(`${ARTIFACTS[pkg]}: ${getArtifactAnchorLink(pkg)}`));
}
