package policytest

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/palantir/policy-bot/policy"
	"github.com/palantir/policy-bot/policy/common"
	"github.com/palantir/policy-bot/pull"
	"github.com/palantir/policy-bot/pull/pulltest"
	"gopkg.in/yaml.v2"
)

// These tests load the repository .policy.yml and evaluate it with
// github.com/palantir/policy-bot v1.42.1, the same evaluator the merge gate
// runs. They describe the approval outcome the policy must produce.
//
// While the changelog and bot path patterns are unanchored, and while the
// changelog rule leaves invalidate_on_push unset (the library default is
// false), the cases below that require a pending or skipped policy fail.

const (
	outsider   = "outside-contributor"
	maintainer = "maintainer"
	excavator  = "svc-excavator-bot"
)

func TestOutsideContributorCannotLandUnreviewedFilesAfterChangelogApproval(t *testing.T) {
	// A maintainer approved an earlier revision. The contributor then pushed a
	// tree whose paths only contain the changelog pattern as a substring.
	// That push must leave the policy unapproved: the previous review did not
	// cover these files, and a new review of them must not be enough either
	// unless every file is a package changelog entry.
	pushed := time.Date(2026, 11, 25, 12, 0, 0, 0, time.UTC)
	stale := pushed.Add(-time.Hour)

	malicious := []string{
		"packages/core/src/changelog/@unreleased/a.yml.test.ts",
		"packages/core/src/changelog/@unreleased/a.yml.test.tsx",
		"packages/core/src/changelog/@unreleased/a.yml.stories.tsx",
		"packages/core/src/changelog/@unreleased/a.yml.stories.ts",
		"packages/core/src/changelog/@unreleased/a.yml.ts",
		"packages/core/src/changelog/@unreleased/a.yml.tsx",
		"packages/core/src/changelog/@unreleased/a.yml.js",
		"packages/core/src/components/button/changelog/@unreleased/hook.yml.ts",
		"packages/core/changelog/@unreleased/entry.yml.md",
		"packages/core/changelog/@unreleased/entry.yml/extra.ts",
		"packages/core/changelog/@unreleased/nested/entry.yml",
		"changelog/@unreleased/not-under-packages.yml",
	}

	for _, path := range malicious {
		t.Run("stale/"+path, func(t *testing.T) {
			result := evaluate(t, pullRequest{
				author:   outsider,
				files:    []string{path},
				head:     "headsha1",
				pushedAt: pushed,
				reviewAt: stale,
			})
			if result.Status == common.StatusApproved {
				t.Fatalf("stale maintainer approval satisfied the policy for %s\n%s", path, summarize(result))
			}
		})
	}

	t.Run("stale/mixed with a real changelog entry", func(t *testing.T) {
		result := evaluate(t, pullRequest{
			author: outsider,
			files: []string{
				"packages/core/changelog/@unreleased/pr-1.yml",
				"packages/core/src/changelog/@unreleased/a.yml.test.ts",
			},
			head:     "headsha1",
			pushedAt: pushed,
			reviewAt: stale,
		})
		if result.Status == common.StatusApproved {
			t.Fatalf("adding a real changelog entry made the unreviewed test file approved\n%s", summarize(result))
		}
	})
}

func TestChangelogApprovalDoesNotSurviveThePushItWasGivenFor(t *testing.T) {
	pushed := time.Date(2026, 11, 25, 12, 0, 0, 0, time.UTC)
	real := "packages/core/changelog/@unreleased/pr-1.yml"

	t.Run("approval before the head was pushed", func(t *testing.T) {
		result := evaluate(t, pullRequest{
			author:   outsider,
			files:    []string{real},
			head:     "headsha1",
			pushedAt: pushed,
			reviewAt: pushed.Add(-time.Minute),
		})
		if result.Status == common.StatusApproved {
			t.Fatalf("changelog rule kept an approval from before the reviewed commit was pushed\n%s", summarize(result))
		}
	})

	t.Run("approval after the head was pushed", func(t *testing.T) {
		result := evaluate(t, pullRequest{
			author:   outsider,
			files:    []string{real, "packages/datetime/changelog/@unreleased/pr-2.yml"},
			head:     "headsha1",
			pushedAt: pushed,
			reviewAt: pushed.Add(time.Minute),
		})
		if result.Status != common.StatusApproved {
			t.Fatalf("a changelog entry reviewed after it was pushed was not approved\n%s", summarize(result))
		}
	})

	t.Run("web update merge after approval", func(t *testing.T) {
		// The head is a GitHub update-merge of develop into the PR. The
		// maintainer approved the changelog commit itself, before that merge.
		parentPushed := pushed.Add(-time.Hour)
		result := evaluate(t, pullRequest{
			author:   outsider,
			files:    []string{real},
			head:     "mergehead",
			pushedAt: pushed,
			reviewAt: parentPushed.Add(time.Minute),
			commits: []*pull.Commit{
				{
					SHA:             "mergehead",
					Parents:         []string{"changelogsha", "developsha"},
					CommittedViaWeb: true,
					Author:          outsider,
					Committer:       outsider,
				},
				{
					SHA:       "changelogsha",
					Parents:   []string{"basesha"},
					Author:    outsider,
					Committer: outsider,
				},
			},
			extraPushedAt: map[string]time.Time{
				"changelogsha": parentPushed,
			},
		})
		if result.Status == common.StatusApproved {
			t.Fatalf("an update merge left the earlier changelog approval in force\n%s", summarize(result))
		}
	})
}

func TestUnrelatedSourceStillRequiresAReviewOfThatPush(t *testing.T) {
	pushed := time.Date(2026, 11, 25, 12, 0, 0, 0, time.UTC)
	result := evaluate(t, pullRequest{
		author:   outsider,
		files:    []string{"packages/core/src/components/button/button.tsx"},
		head:     "headsha1",
		pushedAt: pushed,
		reviewAt: pushed.Add(-time.Hour),
	})
	if result.Status == common.StatusApproved {
		t.Fatalf("external contributor rule accepted a stale approval\n%s", summarize(result))
	}
}

func TestBotPathRulesDoNotMatchLookalikeFiles(t *testing.T) {
	// The excavator rules share the same unanchored patterns. They also require
	// the bot author and a signature the policy allowlists; this context has
	// both, and no human approval, so only a count:0 path rule can approve.
	//
	// Paths that must still approve: a direct child of .circleci ending in
	// .yml, package.json at the repo root or one package directory down,
	// pnpm-lock.yaml at the repo root, a root dotfile whose name ends in
	// .yml, and a .yml file under .github. A directory between .circleci and
	// the file is not a circle config, and a root dotfile whose suffix is
	// not ".yml" is not a config file.
	lookalikes := []string{
		"packages/core/src/changelog/@unreleased/a.yml.test.ts",
		"packages/core/changelog/@unreleased/entry.yml/extra.ts",
		".circleci/hooks/evil.sh",
		".circleci/config.yml.bak",
		".circleci/dir/config.yml",
		"packages/core/src/notpackage.json",
		"packages/core/src/packageXjson",
		"packages/core/src/package.json",
		"packages/core/pnpm-lock.yaml",
		"pnpm-lockXyaml",
		".policyXyml",
		"packages/core/.policy.yml",
	}
	for _, path := range lookalikes {
		t.Run(path, func(t *testing.T) {
			result := evaluate(t, pullRequest{
				author: excavator,
				files:  []string{path},
				head:   "botsha1",
				signed: true,
			})
			if result.Status == common.StatusApproved {
				t.Fatalf("bot path rule approved %s\n%s", path, summarize(result))
			}
		})
	}

	legitimate := []struct {
		name  string
		files []string
	}{
		{"root package.json", []string{"package.json"}},
		{"package package.json", []string{"packages/core/package.json"}},
		{"root lockfile", []string{"pnpm-lock.yaml"}},
		{"package.json and lockfile", []string{"package.json", "packages/core/package.json", "pnpm-lock.yaml"}},
		{"circle config", []string{".circleci/config.yml"}},
		{"circle config and changelog", []string{".circleci/config.yml", "packages/core/changelog/@unreleased/exc.yml"}},
		{"root dotfile", []string{".policy.yml"}},
		{"github workflow", []string{".github/workflows/ci.yml"}},
	}
	for _, tc := range legitimate {
		t.Run(tc.name, func(t *testing.T) {
			result := evaluate(t, pullRequest{
				author: excavator,
				files:  tc.files,
				head:   "botsha1",
				signed: true,
			})
			if result.Status != common.StatusApproved {
				t.Fatalf("bot path rule rejected %s\n%s", tc.name, summarize(result))
			}
		})
	}
}

type pullRequest struct {
	author        string
	files         []string
	head          string
	pushedAt      time.Time
	reviewAt      time.Time
	reviewer      string
	commits       []*pull.Commit
	extraPushedAt map[string]time.Time
	signed        bool
}

func evaluate(t *testing.T, pr pullRequest) common.Result {
	t.Helper()
	evaluator := loadPolicy(t)

	if pr.reviewer == "" {
		pr.reviewer = maintainer
	}
	files := make([]*pull.File, len(pr.files))
	for i, name := range pr.files {
		files[i] = &pull.File{Filename: name, Status: pull.FileAdded}
	}

	commits := pr.commits
	if commits == nil {
		commit := &pull.Commit{
			SHA:       pr.head,
			Author:    pr.author,
			Committer: pr.author,
		}
		if pr.signed {
			commit.Signature = &pull.Signature{
				Type:    pull.SignatureGpg,
				IsValid: true,
				KeyID:   signingKey(t),
				State:   "VALID",
			}
		}
		commits = []*pull.Commit{commit}
	} else if pr.signed {
		for _, commit := range commits {
			commit.Signature = &pull.Signature{
				Type:    pull.SignatureGpg,
				IsValid: true,
				KeyID:   signingKey(t),
				State:   "VALID",
			}
		}
	}

	pushedAt := map[string]time.Time{}
	for sha, at := range pr.extraPushedAt {
		pushedAt[sha] = at
	}
	if !pr.pushedAt.IsZero() {
		pushedAt[pr.head] = pr.pushedAt
	}

	var reviews []*pull.Review
	if !pr.reviewAt.IsZero() {
		reviews = []*pull.Review{{
			ID:        "review1",
			Author:    pr.reviewer,
			State:     pull.ReviewApproved,
			CreatedAt: pr.reviewAt,
		}}
	}

	prctx := &pulltest.Context{
		OwnerValue:        "palantir",
		RepoValue:         "blueprint",
		NumberValue:       1,
		AuthorValue:       pr.author,
		HeadSHAValue:      pr.head,
		BranchBaseName:    "develop",
		BranchHeadName:    "contributor-branch",
		ChangedFilesValue: files,
		CommitsValue:      commits,
		PushedAtValue:     pushedAt,
		ReviewsValue:      reviews,
		CollaboratorsValue: []*pull.Collaborator{
			{
				Name: maintainer,
				Permissions: []pull.CollaboratorPermission{{
					Permission: pull.PermissionAdmin,
					ViaRepo:    true,
				}},
			},
		},
	}

	result := evaluator.Evaluate(context.Background(), prctx)
	if result.Error != nil {
		t.Fatalf("policy evaluation error: %v", result.Error)
	}
	return result
}

var (
	loadedPolicy common.Evaluator
	loadedConfig *policy.Config
)

func loadPolicy(t *testing.T) common.Evaluator {
	t.Helper()
	if loadedPolicy != nil {
		return loadedPolicy
	}

	path := filepath.Join("..", "..", ".policy.yml")
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read policy: %v", err)
	}
	var cfg policy.Config
	if err := yaml.Unmarshal(body, &cfg); err != nil {
		t.Fatalf("parse policy: %v", err)
	}
	// nil global options: no server approval_defaults. Unset rule options then
	// use the library defaults in policy-bot v1.42.1.
	evaluator, err := policy.ParsePolicy(&cfg, nil)
	if err != nil {
		t.Fatalf("load policy: %v", err)
	}
	loadedConfig = &cfg
	loadedPolicy = evaluator
	return evaluator
}

func signingKey(t *testing.T) string {
	t.Helper()
	loadPolicy(t)
	var intersection map[string]bool
	for _, rule := range loadedConfig.ApprovalRules {
		pred := rule.Predicates.HasValidSignaturesByKeys
		if pred == nil {
			continue
		}
		current := map[string]bool{}
		for _, id := range pred.KeyIDs {
			current[id] = true
		}
		if intersection == nil {
			intersection = current
			continue
		}
		for id := range intersection {
			if !current[id] {
				delete(intersection, id)
			}
		}
	}
	for id := range intersection {
		return id
	}
	t.Fatal("policy signature rules have no key in common")
	return ""
}

func summarize(result common.Result) string {
	return result.Status.String() + ": " + result.StatusDescription + "\n" + joinLines(ruleLines(result))
}

func ruleLines(result common.Result) []string {
	var lines []string
	if len(result.Children) == 0 && result.Name != "" {
		lines = append(lines, result.Name+"="+result.Status.String()+" ("+result.StatusDescription+")")
	}
	for _, child := range result.Children {
		lines = append(lines, ruleLines(*child)...)
	}
	return lines
}

func joinLines(lines []string) string {
	out := ""
	for _, line := range lines {
		out += line + "\n"
	}
	return out
}
