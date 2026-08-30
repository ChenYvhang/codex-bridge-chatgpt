# Automatic Doctor

Run the local installation check before opening ChatGPT:

```bash
node scripts/doctor.mjs --json
```

Continue only when it returns `READY`. Report `MISSING_RUNTIME` when Node.js 18 or newer is unavailable. Report `INVALID_INSTALLATION` with the failed check IDs when required Skill files are missing or the installed package name is wrong.

Then perform the volatile browser checks on every handoff:

1. Inspect the runtime surface. Return `NEEDS_DESKTOP_APP` only when it explicitly identifies CLI, IDE, cloud, Linux, or another unsupported surface.
2. On a supported Mac or Windows desktop surface, return `NEEDS_BROWSER` when the `browser:control-in-app-browser` Skill or in-app Browser capability is unavailable.
3. Open or claim `https://chatgpt.com/` only in the in-app Browser.
4. Check visible account UI. If logged out, report `NEEDS_CHATGPT_LOGIN`, ask the user to take over the page, and preserve the original task for resume.
5. Check the user-requested model in visible UI. If unavailable, report `NEEDS_MODEL_SELECTION`; never silently substitute another model.
6. If site access is blocked, report `NEEDS_SITE_PERMISSION` and follow the Browser Skill's permission flow.
7. Return `READY` only after authentication and model checks are visibly satisfied.

Never inspect cookies, local storage, browser profiles, passwords, verification codes, or credential files. Human login is a takeover step, not an automation step.
