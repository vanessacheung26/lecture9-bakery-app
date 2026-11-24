# MGOC50 Lecture 9

This folder holds two things:
- The Agentic Workflow Builder: Workflow-Builder.html and the files it uses (analyze.js, data.js, designs.js, engine.js, logs.js, policy.js, server.py).
- The bakery app, which the student builds in this folder. Its starting data is existing_orders.csv, and its Instagram messages are in the seven InstagramOrders files (Monday to Sunday). The bakery app doesn't use the Workflow Builder's files: never read or change them while building it.

## The Agentic Workflow Builder

Workflow-Builder.html is the Lecture 9 copy of the Agentic Workflow Builder. It has two tabs. "Build and run" shows the DoorDash refund workflow that runs now (week 2). "Analyze logs" holds two weeks of that workflow's chat logs (logs.js): both weeks' numbers side by side, three approaches to analyze them (Stopping point distribution, Differential analysis: week 1 vs week 2, Categorical Breakdown), and every chat as a story. analyze.js draws the Analyze logs tab, engine.js is the harness, policy.js holds the policy, and designs.js holds the workflow. The page is complete: nothing needs to be written or changed in class.

To start or open Workflow-Builder.html: run `python3 server.py` in this folder (on Windows, `python server.py`) as a background command that keeps running, and open http://127.0.0.1:8009/Workflow-Builder.html in the student's browser. If port 8009 is taken, run `python3 server.py 8010` and open the address with 8010. "Analyze logs" does not need Ollama. Only "Run it" in "Build and run" calls the agent: for that, open the Ollama app, and if `ollama list` doesn't show qwen3:1.7b, run `ollama pull qwen3:1.7b`.

"Download the logs" at the bottom of "Analyze logs" saves both weeks as a spreadsheet file (one row per chat), which can be analyzed further here.

## The bakery app

### Technical setup
- Build a web app in Python, using the standard library only. Keep all data in one SQLite file, `bakery.db`, in this folder.
- No Node.js, npm or installs.
- One file, `app.py`, serves the page and keeps `bakery.db`.
- The page is plain HTML, CSS and JavaScript sent by `app.py`.
- The app runs on this computer at http://127.0.0.1:8000.
- No AI inside the app. Every automatic decision is a fixed rule.
- The person using this folder is not a programmer. Tell them in plain words how to start the app, and keep the steps short.

### Files in this folder
- `InstagramOrders_Monday.html` to `InstagramOrders_Sunday.html`: the Instagram messages, one file per day, Monday 23 to Sunday 29 November 2026.
- `existing_orders.csv`: the orders taken before Monday 23 November.

### Testing
- Run tests on a copy of `bakery.db`, never on the real one.

### GitHub upload
- Use GitHub CLI (`gh`) and Git. Installing them is allowed for this upload, even though the app itself uses no installs. If `gh` is missing, download the official release zip from https://github.com/cli/cli/releases and unzip it outside this folder (no admin password needed).
- Sign in with `gh auth login --web --git-protocol https`. It waits for the student, so run it in the background, show the student the one-time code and https://github.com/login/device, and check `gh auth status` when they say done. Then run `gh auth setup-git`.
- Set git `user.name` to the student's GitHub username and `user.email` to their GitHub noreply address (ID+username@users.noreply.github.com), so their real email is not public.
- Never ask for a password or token.
