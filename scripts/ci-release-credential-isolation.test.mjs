/**
 * Spec for release credentials in the CircleCI pipeline.
 *
 * These tests fail while the vulnerability is present. They execute the job
 * commands from `.circleci/config.yml` in a checkout of a non-protected branch
 * whose scripts have been replaced. CircleCI project environment variables are
 * injected into every non-fork job, which is the behavior documented for
 * project settings variables (they are not passed to fork builds unless that
 * setting is turned on). `circleci run oidc get` is stubbed to print a token
 * on stdout, which is the environment CLI contract those job commands use.
 *
 * A passing run means a feature-branch checkout cannot observe the GitHub App
 * credentials, the CircleCI API token, or an npm OIDC token, including when
 * the publish workflow filter is removed and the publish scripts are replaced.
 * The branch check inside the checked-out publish script is not the control.
 *
 * Untested operations that share the project-environment exposure:
 * - tag builds, where `scripts/circle-publish-npm` treats `CIRCLE_TAG` as develop
 * - `pnpm` script entries invoked by checkout-code, compile, lint, test, dist,
 *   format-check, clean-lockfile, type-check-icons, compile-docs, and chromatic
 *   (those commands are stubbed here, so a replaced package.json script is not executed)
 * - a rewrite of the `run` command text itself in the pipeline file on the branch
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const configPath = join(repoRoot, ".circleci", "config.yml");

const CREDENTIAL_NAMES = [
    "GITHUB_APP_ID",
    "GITHUB_APP_PRIVATE_KEY",
    "GITHUB_APP_INSTALLATION_ID",
    "CIRCLE_API_TOKEN",
    "NPM_ID_TOKEN",
    "CHROMATIC_PROJECT_TOKEN",
];

const PLACEHOLDERS = {
    GITHUB_APP_ID: "placeholder-app-id",
    GITHUB_APP_PRIVATE_KEY: Buffer.from("placeholder-private-key", "utf8").toString("base64"),
    GITHUB_APP_INSTALLATION_ID: "placeholder-installation-id",
    CIRCLE_API_TOKEN: "placeholder-circle-token",
    CHROMATIC_PROJECT_TOKEN: "placeholder-chromatic-token",
};

const OIDC_TOKEN = "placeholder-npm-oidc-token";

const FILES = [
    ".circleci/config.yml",
    "scripts/submit-preview-comment.sh",
    "scripts/submit-comment-with-artifact-links.mjs",
    "scripts/publish-npm-semver-tagged",
    "scripts/circle-publish-npm",
    "scripts/get-publishable-paths-from-semver-tags.mjs",
    "scripts/pack-npm",
];

function loadConfig(path) {
    const parsed = spawnSync(
        "python3",
        ["-c", "import json,sys,yaml; json.dump(yaml.safe_load(open(sys.argv[1])), sys.stdout)", path],
        {
            encoding: "utf8",
        },
    );
    assert.equal(parsed.status, 0, parsed.stderr);
    return JSON.parse(parsed.stdout);
}

function branchMatches(pattern, branch) {
    if (pattern.startsWith("/") && pattern.endsWith("/")) {
        return new RegExp(pattern.slice(1, -1)).test(branch);
    }
    if (pattern.endsWith("/*")) {
        return branch.startsWith(pattern.slice(0, -1));
    }
    return pattern === branch;
}

function branchAllowed(filters, branch) {
    const branches = filters?.branches;
    if (!branches) {
        return true;
    }
    if (branches.only) {
        const only = Array.isArray(branches.only) ? branches.only : [branches.only];
        if (!only.some(pattern => branchMatches(pattern, branch))) {
            return false;
        }
    }
    if (branches.ignore) {
        const ignore = Array.isArray(branches.ignore) ? branches.ignore : [branches.ignore];
        if (ignore.some(pattern => branchMatches(pattern, branch))) {
            return false;
        }
    }
    return true;
}

function scheduledJobNames(config, branch) {
    const jobs = config.workflows.compile_lint_test_dist_deploy.jobs;
    const names = [];
    for (const entry of jobs) {
        if (typeof entry === "string") {
            names.push(entry);
            continue;
        }
        const [name, options] = Object.entries(entry)[0];
        if (branchAllowed(options?.filters, branch)) {
            names.push(name);
        }
    }
    return names;
}

function runCommand(step) {
    if (step.run == null) {
        return null;
    }
    return typeof step.run === "string" ? step.run : step.run.command;
}

function git(cwd, args) {
    const result = spawnSync("git", args, {
        cwd,
        encoding: "utf8",
        env: {
            ...process.env,
            GIT_AUTHOR_NAME: "credential-test",
            GIT_AUTHOR_EMAIL: "credential-test@example.com",
            GIT_COMMITTER_NAME: "credential-test",
            GIT_COMMITTER_EMAIL: "credential-test@example.com",
            GIT_CONFIG_COUNT: "1",
            GIT_CONFIG_KEY_0: "commit.gpgsign",
            GIT_CONFIG_VALUE_0: "false",
        },
    });
    assert.equal(result.status, 0, `${args.join(" ")}\n${result.stderr}`);
}

function writeExecutable(path, contents) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
    chmodSync(path, 0o755);
}

function recorderShell() {
    const script = [
        "const fs=require('fs');",
        "const names=(process.env.CREDENTIAL_NAMES||'').split(',').filter(Boolean);",
        "const observed={};",
        "for (const name of names) observed[name]=process.env[name]??null;",
        "fs.appendFileSync(process.env.CREDENTIAL_SINK, JSON.stringify(observed)+'\\n');",
    ].join(" ");
    return `#!/usr/bin/env bash\nnode -e ${JSON.stringify(script)}\n`;
}

function installStubs(binDir, oidcLog) {
    writeExecutable(
        join(binDir, "circleci"),
        `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$OIDC_LOG"
if [[ "$1" == "run" && "$2" == "oidc" && "$3" == "get" ]]; then
  printf '%s' "$STUB_OIDC_TOKEN"
  exit 0
fi
echo "unexpected circleci invocation: $*" >&2
exit 1
`,
    );
    writeExecutable(
        join(binDir, "curl"),
        `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$CURL_LOG"
printf '%s' '{"items":[]}'
`,
    );
    for (const name of ["sudo", "corepack", "pnpm"]) {
        writeExecutable(join(binDir, name), "#!/usr/bin/env bash\nexit 0\n");
    }
    writeFileSync(oidcLog, "");
}

function materializeCheckout(replacements) {
    const root = mkdtempSync(join(tmpdir(), "blueprint-ci-cred-"));
    const workspace = join(root, "repo");
    mkdirSync(workspace, { recursive: true });
    for (const relative of FILES) {
        const destination = join(workspace, relative);
        mkdirSync(dirname(destination), { recursive: true });
        writeFileSync(destination, readFileSync(join(repoRoot, relative)));
        const base = relative.slice(relative.lastIndexOf("/") + 1);
        if (!base.includes(".") || base.endsWith(".sh")) {
            chmodSync(destination, 0o755);
        }
    }
    git(workspace, ["init", "-q", "-b", "develop"]);
    git(workspace, ["add", "."]);
    git(workspace, ["commit", "-q", "-m", "trusted default"]);
    git(workspace, ["update-ref", "refs/remotes/origin/develop", "HEAD"]);
    for (const [relative, contents] of Object.entries(replacements)) {
        const destination = join(workspace, relative);
        writeFileSync(destination, contents);
        chmodSync(destination, 0o755);
    }
    git(workspace, ["checkout", "-q", "-b", "feature/attacker"]);
    git(workspace, ["add", "."]);
    git(workspace, ["commit", "-q", "-m", "feature checkout"]);
    return { root, workspace };
}

function projectEnv({ fork, branch, sink, oidcLog, curlLog, extra }) {
    const env = {
        ...process.env,
        CIRCLECI: "true",
        CIRCLE_BRANCH: branch,
        CIRCLE_BUILD_NUM: "100",
        CIRCLE_SHA1: "0123456789abcdef0123456789abcdef01234567",
        CIRCLE_PROJECT_USERNAME: "palantir",
        CIRCLE_PROJECT_REPONAME: "blueprint",
        CREDENTIAL_SINK: sink,
        CREDENTIAL_NAMES: CREDENTIAL_NAMES.join(","),
        OIDC_LOG: oidcLog,
        CURL_LOG: curlLog,
        STUB_OIDC_TOKEN: OIDC_TOKEN,
        ...extra,
    };
    if (!fork) {
        Object.assign(env, PLACEHOLDERS);
    }
    return env;
}

function executeRunSteps(workspace, steps, env) {
    const commands = [];
    for (const step of steps) {
        const command = runCommand(step);
        if (command == null) {
            continue;
        }
        commands.push(command);
        const result = spawnSync("bash", ["--noprofile", "--norc", "-c", command], {
            cwd: workspace,
            env,
            encoding: "utf8",
        });
        if (result.error) {
            throw result.error;
        }
    }
    return commands;
}

function readSink(sink) {
    if (!existsSync(sink)) {
        return [];
    }
    const text = readFileSync(sink, "utf8").trim();
    if (text.length === 0) {
        return [];
    }
    return text.split("\n").map(line => JSON.parse(line));
}

function leakedNames(rows) {
    const names = new Set();
    for (const observed of rows) {
        for (const name of CREDENTIAL_NAMES) {
            if (observed[name] != null && observed[name] !== "") {
                names.add(name);
            }
        }
        if (observed.GITHUB_APP_PRIVATE_KEY_DECODED) {
            names.add("GITHUB_APP_PRIVATE_KEY_DECODED");
        }
    }
    return [...names];
}

function assertNoLeak(observed) {
    assert.deepEqual(
        leakedNames(observed),
        [],
        `checked-out code observed credential environment variables: ${leakedNames(observed).join(", ")}`,
    );
}

function runScheduledJobs(workspace, branch, env, { stripPublishFilter = false } = {}) {
    const config = loadConfig(join(workspace, ".circleci/config.yml"));
    if (stripPublishFilter) {
        for (const entry of config.workflows.compile_lint_test_dist_deploy.jobs) {
            if (entry && typeof entry === "object" && entry["deploy-npm"]) {
                delete entry["deploy-npm"].filters;
            }
        }
    }
    const ran = [];
    for (const name of scheduledJobNames(config, branch)) {
        ran.push(name);
        executeRunSteps(workspace, config.jobs[name].steps, env);
    }
    return ran;
}

test("feature-branch preview and package jobs do not pass project credentials to replaced checkout scripts", () => {
    const { root, workspace } = materializeCheckout({
        "scripts/submit-preview-comment.sh": recorderShell(),
        "scripts/pack-npm": recorderShell(),
    });
    const sink = join(root, "sink.json");
    const oidcLog = join(root, "oidc.log");
    const curlLog = join(root, "curl.log");
    const bin = join(root, "bin");
    installStubs(bin, oidcLog);
    const env = projectEnv({ fork: false, branch: "feature/attacker", sink, oidcLog, curlLog });
    env.PATH = `${bin}:${env.PATH}`;
    try {
        const ran = runScheduledJobs(workspace, "feature/attacker", env);
        assert.ok(ran.includes("deploy-preview"));
        assert.ok(ran.includes("store-packages"));
        assert.equal(ran.includes("deploy-npm"), false);
        assertNoLeak(readSink(sink));
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("the checked-out comment module must not receive project credentials from the preview shell", () => {
    const { root, workspace } = materializeCheckout({
        "scripts/submit-comment-with-artifact-links.mjs": `import fs from "node:fs";

const names = (process.env.CREDENTIAL_NAMES || "").split(",").filter(Boolean);
const observed = {};
for (const name of names) observed[name] = process.env[name] ?? null;
if (observed.GITHUB_APP_PRIVATE_KEY) {
    observed.GITHUB_APP_PRIVATE_KEY_DECODED = Buffer.from(observed.GITHUB_APP_PRIVATE_KEY, "base64").toString("utf8");
}
fs.appendFileSync(process.env.CREDENTIAL_SINK, JSON.stringify(observed) + "\\n");
`,
    });
    const sink = join(root, "sink.json");
    const oidcLog = join(root, "oidc.log");
    const curlLog = join(root, "curl.log");
    const bin = join(root, "bin");
    installStubs(bin, oidcLog);
    const env = projectEnv({ fork: false, branch: "feature/attacker", sink, oidcLog, curlLog });
    env.PATH = `${bin}:${env.PATH}`;
    try {
        const ran = runScheduledJobs(workspace, "feature/attacker", env);
        assert.ok(ran.includes("deploy-preview"));
        assertNoLeak(readSink(sink));
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("fork preview execution does not receive project credentials", () => {
    const { root, workspace } = materializeCheckout({
        "scripts/submit-preview-comment.sh": recorderShell(),
        "scripts/pack-npm": recorderShell(),
    });
    const sink = join(root, "sink.json");
    const oidcLog = join(root, "oidc.log");
    const curlLog = join(root, "curl.log");
    const bin = join(root, "bin");
    installStubs(bin, oidcLog);
    const env = projectEnv({ fork: true, branch: "feature/attacker", sink, oidcLog, curlLog });
    env.PATH = `${bin}:${env.PATH}`;
    try {
        runScheduledJobs(workspace, "feature/attacker", env);
        assertNoLeak(readSink(sink));
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("removing the publish branch filter still must not request an npm token for a feature checkout", () => {
    const { root, workspace } = materializeCheckout({
        "scripts/publish-npm-semver-tagged": recorderShell(),
        "scripts/circle-publish-npm": recorderShell(),
    });
    const sink = join(root, "sink.json");
    const oidcLog = join(root, "oidc.log");
    const curlLog = join(root, "curl.log");
    const bin = join(root, "bin");
    installStubs(bin, oidcLog);
    const env = projectEnv({ fork: false, branch: "feature/attacker", sink, oidcLog, curlLog });
    env.PATH = `${bin}:${env.PATH}`;
    try {
        const ran = runScheduledJobs(workspace, "feature/attacker", env, { stripPublishFilter: true });
        assert.ok(ran.includes("deploy-npm"));
        assert.equal(readFileSync(oidcLog, "utf8").includes("oidc get"), false);
        assertNoLeak(readSink(sink));
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("a release-branch name does not let the checked-out publish script observe the npm token", () => {
    const { root, workspace } = materializeCheckout({
        "scripts/publish-npm-semver-tagged": recorderShell(),
        "scripts/circle-publish-npm": recorderShell(),
    });
    const sink = join(root, "sink.json");
    const oidcLog = join(root, "oidc.log");
    const curlLog = join(root, "curl.log");
    const bin = join(root, "bin");
    installStubs(bin, oidcLog);
    const config = loadConfig(join(workspace, ".circleci/config.yml"));
    const env = projectEnv({ fork: false, branch: "develop", sink, oidcLog, curlLog });
    env.PATH = `${bin}:${env.PATH}`;
    try {
        executeRunSteps(workspace, config.jobs["deploy-npm"].steps, env);
        assertNoLeak(readSink(sink));
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("the checked-out publish script is not the branch control for next or release branches", () => {
    for (const branch of ["next", "release/6.x.x"]) {
        const { root, workspace } = materializeCheckout({
            "scripts/publish-npm-semver-tagged": recorderShell(),
            "scripts/circle-publish-npm": recorderShell(),
        });
        const sink = join(root, "sink.json");
        const oidcLog = join(root, "oidc.log");
        const curlLog = join(root, "curl.log");
        const bin = join(root, "bin");
        installStubs(bin, oidcLog);
        const config = loadConfig(join(workspace, ".circleci/config.yml"));
        const env = projectEnv({ fork: false, branch, sink, oidcLog, curlLog });
        env.PATH = `${bin}:${env.PATH}`;
        try {
            executeRunSteps(workspace, config.jobs["deploy-npm"].steps, env);
            assertNoLeak(readSink(sink));
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    }
});
