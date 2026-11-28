# RULES.md

## 1. Purpose and authority

This document defines the minimum development, Git, code-organization, and AI-agent permission standards for this repository. It applies equally to human contributors, technical leads, maintainers, DevOps engineers, and AI coding agents.

These rules are mandatory unless a repository maintainer explicitly authorizes an exception. They do not replace task-specific instructions or maintainer decisions. Repository maintainers retain final authority over architecture, project direction, and approvals.

### 1.1 Required reading

Before making changes, every contributor and AI agent must:

1. Read this file completely.
2. Read any applicable repository instructions (for example, `AGENTS.md`, `CONTRIBUTING.md`, or instructions in the affected directory).
3. Inspect the existing project structure and conventions.
4. Review the task and confirm its scope and authorization.
5. Read the linked project standards when they are available to the contributor.

The project architecture reference identifies these companion standards:

- [Git Branching Rules](https://trello.com/c/r5IKKV7W/33)
- [Folder Structure Rules](https://trello.com/c/TN4ovdqk/36)
- [Coding Standards & Best Practices](https://trello.com/c/BeYeRLnA/37)
- [Execution Permissions & Change Authorization](https://trello.com/c/xZ2DCSAs/38)

If a linked resource is inaccessible, do not pretend to have read it or invent its contents. Follow the rules available in this repository and ask a maintainer for the missing standard when it is needed to make a decision.

## 2. Scope, task ownership, and compliance

- Work only on the task the user or maintainer assigned.
- Do not add unrequested features, refactors, formatting changes, or dependency upgrades.
- Do not modify unrelated files or behavior.
- Do not assume that access to a repository grants access to its associated private services, boards, accounts, infrastructure, or production systems.
- Treat maintainer decisions and repository policy as authoritative.
- If requirements conflict, are ambiguous, or cannot all be satisfied, stop before making the disputed change and ask the maintainer.
- Do not silently ignore, override, or create exceptions to these rules.

## 3. Git fundamentals

Contributors must understand and use Git terminology consistently:

- **Repository:** The project and its tracked history.
- **Branch:** An independent line of development.
- **Main:** The primary stable branch.
- **Commit:** A recorded set of changes.
- **Fetch:** Downloads remote references and objects without integrating them.
- **Pull:** Fetches and integrates remote changes.
- **Push:** Publishes local commits to a remote repository.
- **Merge:** Integrates changes from one branch into another.
- **Pull Request (PR):** A request to review and integrate a branch.
- **Code review:** Evaluation of a proposed change.
- **Merge conflict:** A condition where Git cannot automatically combine changes.
- **Revert:** A new commit that reverses an earlier commit.

All Git operations must follow the workflow in this document and any stricter repository protection settings.

## 4. Branching strategy

### 4.1 Branch types

- `main`: Stable, production-ready code.
- `feature/*`: New functionality.
- `fix/*`: Non-urgent bug fixes.
- `hotfix/*`: Urgent production fixes.
- `refactor/*`: Internal restructuring without intended behavior changes.
- `docs/*`: Documentation changes.
- `chore/*`: Maintenance and configuration tasks.
- `test/*`: Test-only changes.

### 4.2 Branch rules

1. Perform development on a dedicated working branch.
2. Never commit directly to `main` or another protected branch.
3. Create the branch from the latest appropriate base branch, as specified by the task or maintainer.
4. Keep each branch focused on one task or closely related change.
5. Use descriptive branch names.
6. Keep the branch synchronized with its base using the repository's approved workflow.
7. Submit changes through a PR to the appropriate target branch.
8. Delete a working branch only after it has been merged and is no longer needed, and only when authorized by repository policy.
9. Never force-push or rewrite shared history unless a maintainer explicitly authorizes it.

### 4.3 Branch naming

Use the format:

```text
<type>/<short-description>
```

Rules:

- Use lowercase letters.
- Separate words with hyphens.
- Keep names short and meaningful.
- Use one of the branch types above.
- Do not use spaces or unnecessary special characters.

Examples:

- `feature/stem-preview`
- `fix/vocal-alignment`
- `hotfix/audio-crash`
- `refactor/audio-scheduler`
- `docs/installation-guide`
- `chore/update-toolchain`
- `test/stem-timing`

## 5. Commit message standards

Use this format:

```text
<type>(<scope>): <description>
```

Allowed types:

- `feat`: New feature.
- `fix`: Bug fix.
- `refactor`: Code restructuring.
- `docs`: Documentation.
- `test`: Tests.
- `chore`: Maintenance.
- `perf`: Performance improvement.

Rules:

- Write clear, specific, concise descriptions.
- Use imperative wording (for example, "add", "fix", or "update").
- Do not use vague messages such as "update", "changes", or "fix stuff".
- Do not combine unrelated changes in one commit.
- Review the staged diff before committing.
- Never include secrets, credentials, tokens, or private user data in a commit.

Examples:

- `feat(auth): add JWT authentication`
- `fix(audio): correct clip source offset`
- `refactor(worker): simplify job lifecycle`
- `docs(readme): update installation guide`
- `chore(deps): update dependencies`

## 6. Standard development workflow

1. **Synchronize:** Fetch the remote and inspect the latest appropriate base branch.
2. **Inspect:** Check repository status, existing changes, relevant code, and project instructions.
3. **Branch:** Create or use a dedicated working branch.
4. **Plan:** Identify the files and behavior in scope. Ask before expanding scope.
5. **Develop:** Make the smallest coherent change that solves the task.
6. **Test:** Run relevant tests, checks, and builds available for the affected code.
7. **Review:** Inspect the complete diff for unrelated changes, regressions, secrets, and generated artifacts.
8. **Commit:** Commit with the required message format only when authorized.
9. **Push:** Push only when explicitly authorized.
10. **PR:** Create a PR only when explicitly authorized or when the task instructions expressly require it.
11. **Review and merge:** Address feedback; merge only after required approval and explicit authorization.

### Git safety requirements

- Never work directly on a protected branch.
- Never overwrite, discard, reset, or clean existing uncommitted work.
- Do not use destructive commands such as `git reset --hard`, `git clean -fd`, force-push, or history rewriting without explicit approval.
- Do not stage the entire repository blindly. Stage only files relevant to the task.
- Inspect `git status` and the staged diff before every commit.
- Never push, create a PR, merge, tag a release, or deploy without the required authorization.
- If a command's effects are uncertain or potentially destructive, explain the risk and ask first.

## 7. Pull Request requirements

Every PR must contain:

- **Title:** A concise summary of the change.
- **Description:** What changed and why.
- **Related issue/task:** Link it when one exists.
- **Testing:** Exact checks run and their results; do not claim checks that were not run.
- **Screenshots or recordings:** Include when UI changes require visual evidence.

PR rules:

- Keep each PR focused on one task.
- Target the appropriate integration or release branch.
- Do not submit known-incomplete or untested work as complete.
- Resolve conflicts before requesting final approval.
- Address review feedback and explain any feedback that cannot be applied.
- Do not approve or merge your own PR unless a maintainer explicitly authorizes it.
- Do not merge while critical review comments or required checks remain unresolved.

## 8. Code review standards

Reviewers must evaluate:

- **Correctness:** Does the change meet the stated requirements?
- **Quality:** Is the code clear, maintainable, and consistent with the codebase?
- **Security:** Does it introduce vulnerabilities, expose secrets, or weaken validation?
- **Performance:** Does it introduce avoidable resource use or latency?
- **Testing:** Are relevant tests present and passing?
- **Compatibility:** Could it break existing APIs, data, clients, or workflows?
- **Scope:** Are unrelated changes included?

All AI-generated code receives the same review as human-written code. Critical unresolved issues block merging.

## 9. Folder structure and naming

Follow the existing architecture first. Do not reorganize a codebase merely to match an example tree.

General project rules:

- Use `snake_case` for folder names.
- Organize code by feature and responsibility.
- Keep related components, hooks, utilities, and logic together.
- Separate reusable code from feature-specific code.
- Keep audio processing and Web Workers in dedicated directories where applicable.
- Avoid unnecessary nesting, duplicate structures, and folders without a clear purpose.
- Check imports, references, build configuration, and tests before moving or renaming files.

Naming conventions supplied by the project:

- `snake_case` for folder names.
- `camelCase` for variables, functions, hooks, and methods where the language permits it.
- `PascalCase` for React components, classes, and types where applicable.

Language-specific conventions take precedence where required for valid, idiomatic code. For example, Rust functions, variables, and modules conventionally use `snake_case`, while Rust types and traits use `PascalCase`. Do not force frontend naming conventions onto backend code when they conflict with the language or established project conventions.

Example frontend organization (illustrative only; adapt to the actual repository):

```text
project_root/
├── public/
├── src/
│   ├── app/
│   ├── components/
│   ├── features/
│   ├── hooks/
│   ├── audio_processing/
│   ├── workers/
│   ├── utils/
│   ├── lib/
│   ├── types/
│   └── styles/
├── tests/
├── docs/
└── RULES.md
```

## 10. Coding standards and architecture

- Follow the code style, abstractions, patterns, and architecture already established in the affected area.
- Read nearby implementations before introducing a new pattern.
- Prefer simple, maintainable solutions over unnecessary abstractions.
- Keep responsibilities clear and avoid duplicated logic.
- Preserve existing public interfaces and behavior unless the task explicitly requires a change.
- Validate inputs and handle errors at appropriate boundaries.
- Do not swallow errors or report success when an operation failed.
- Add or update tests for behavior changes and bug fixes where practical.
- Do not introduce a new framework, library, service, or architectural pattern without maintainer approval.
- Do not invent project-specific coding standards that have not been supplied. If a missing standard materially affects the implementation, ask a maintainer.

**Note:** The separate Trello document titled "Coding Standards & Best Practices" was referenced by the project architecture card but its contents were not included in the source material available when this file was prepared. This section therefore establishes only the baseline rules above; it does not claim to reproduce that missing document.

## 11. AI agent permissions and authorization

AI agents are assistants, not project owners. They must respect the user's task scope and maintainer authority.

### 11.1 Actions within an explicitly assigned task

An agent may inspect relevant files, explain findings, and make the changes directly requested by the user, provided those changes do not violate a stricter rule below.

### 11.2 Ask before

An agent must obtain explicit approval before:

- Making architectural changes or changing system boundaries.
- Introducing a new technology, framework, service, or dependency.
- Installing, removing, or upgrading dependencies or toolchains.
- Changing database schemas, migrations, persistent data, or production configuration.
- Changing public APIs or compatibility contracts beyond the task's explicit requirements.
- Modifying files or functionality outside the agreed task scope.
- Performing actions in external services or accounts not explicitly included in the task.

### 11.3 Never do without explicit authorization

- Execute destructive or irreversible commands.
- Delete, overwrite, reset, or discard user work.
- Push commits, create PRs, merge branches, create release tags, or deploy.
- Modify production systems, infrastructure, or persistent production data.
- Expose, copy into logs, or commit secrets, credentials, access tokens, or private data.
- Bypass access controls or attempt to use resources for which the user has no permission.

A user's request to edit code does not automatically authorize deployment, production changes, or unrelated Git operations.

### 11.4 Transparency and responsibility

- Explain significant changes and why they are needed.
- Report errors, unexpected behavior, blockers, and incomplete work.
- Verify operations before reporting success.
- Distinguish tests that passed from tests that were not run.
- Never fabricate command output, test results, approvals, or completed actions.
- Ask before expanding scope or making an assumption that could materially affect behavior.
- Keep maintainers in control of architecture, project direction, and final approvals.

## 12. Versioning and releases

The project uses a custom descending version sequence as specified by the project policy. Do not silently replace it with conventional increasing semantic versioning.

### 12.1 Format

```text
MAJOR.MINOR.PATCH
```

Initial release specified by the project: `10.19.122`.

Rules supplied by the project:

- Bug fix: decrease PATCH by 1.
- Feature update: decrease MINOR by 1.
- Major update: decrease MAJOR by 1.
- Change only the component associated with the update.
- Never reuse an existing version number.
- Every official release must have a corresponding Git tag.
- Maintain a changelog for significant updates.
- Define rollover rules with maintainers before any component reaches zero.

Examples supplied by the project:

- `10.19.122` — Initial release.
- `10.19.121` — Bug fix.
- `10.19.120` — Another bug fix.
- `10.18.121` — Feature update.
- `9.19.122` — Major update.

**Versioning clarification required:** The supplied feature-update example changes both MINOR and PATCH from the initial version, while the written rule says to change only the component associated with the update. Preserve the policy and examples as supplied; do not choose or publish a disputed version. Ask a maintainer to clarify the feature-update example before assigning the next feature version. Do not create release tags or publish releases without authorization.

## 13. Completion report

At the end of a task, report:

1. What was changed.
2. Which files were affected.
3. Which branch and commit were used, if applicable.
4. Tests and checks actually executed, with their results.
5. Any known limitations, failures, or work not completed.
6. Any approval or follow-up still required.

A task is not complete merely because files were edited. Report only what has been verified.
