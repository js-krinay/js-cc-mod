# request-log

A Claude Code plugin that writes one JSON line for every model request a session makes: the main thread, every subagent, and other plugins' own model calls, at any model and effort. A dashboard reads those lines and shows where your tokens and money went.

Each line holds the time, duration and time to first token; the machine, user, folder and git branch; the session's id and title; the agent; the model asked for and the model that answered; the effort; the stop reason; and the input, output and cache token counts. Prompt and reply text are never logged.

Lines go to `~/.claude/request-log/<UTC date>.jsonl` (under `CLAUDE_CONFIG_DIR` when that is set), one file per day, shared by every session on the machine. Nothing is sent anywhere.

Runs on macOS and Linux. The logger needs only what those systems ship with (`sh`, `perl`, `git`, `hostname`); the dashboard needs [Bun](https://bun.sh).

## Install the logger

At the prompt of a terminal session:

```
/plugin install request-log --marketplace js-krinay/js-cc-mod
```

Answer `y` to add the marketplace, then pick a scope. From a shell:

```
claude plugin install request-log --marketplace js-krinay/js-cc-mod
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `js-krinay/js-cc-mod`, then Add plugin.

New sessions log from then on.

## Run the dashboard

To try it, clone this repository and run it in the foreground:

```
cd dashboard && bun install && bun run start
```

Then open http://127.0.0.1:8787/. It reads the log as it grows, and stops with the terminal.

To keep it running, install it as a service instead:

```
dashboard/install.sh
```

It runs the dashboard as a service on this machine (a launchd agent on macOS, a systemd user service on Linux) and prints its address:

- With [Tailscale](https://tailscale.com) running, it is published to your tailnet only, at `https://<machine>.<tailnet>.ts.net:8443/`.
- Without it, or with `--no-tailscale`, it answers on `http://127.0.0.1:8787/` and only this machine can open it.

`--port` and `--ts-port` change the two ports. Rerunning the script replaces the service in place; `dashboard/install.sh --uninstall` removes it.

The page opens with what is happening now: an estimate of your current 5-hour usage window (worked out from the log alone; Claude's own accounting is not visible to it), the sessions working in the last ten minutes, the last request and today's cost. Below that it shows totals for the period against the period before, requests and cost per day by model, cost by token type, an hour-by-weekday heatmap, each subagent type's share, a timeline of recent sessions, cache hit rate per session, and sortable, paged tables, all under one set of filters kept in the URL.

Cost is what the tokens would cost at Claude API list prices, from `dashboard/prices.json`. A Claude subscription is not billed per token. Update that file when prices change; the dashboard reloads it every five minutes.

### More than one machine

Install the logger on each machine. Pick one machine to show the dashboard and give it each other machine's address:

```
# on the machine you will open
dashboard/install.sh --peer https://other-machine.<tailnet>.ts.net:8443

# on each other machine
dashboard/install.sh --source-only
```

A `--source-only` machine serves its rows to the dashboard and shows no page of its own. The dashboard's Machine filter then splits the requests by machine.

### From anywhere, behind a login

To open the dashboard away from your machines, put a login in front of it before giving it a public name. With Cloudflare, for example:

1. Create a Cloudflare Access application for the hostname, with a policy that allows only your email.
2. Create a Cloudflare Tunnel that sends that hostname to `http://127.0.0.1:8787`, with the tunnel's Access check turned on (`originRequest.access`), and run its connector on this machine.
3. Rerun `dashboard/install.sh` with `--host <your hostname>` (plus any `--peer` you use), so the dashboard answers to that name.
4. Add the DNS record last, then check that a signed-out request is sent to the login page rather than answered.

The dashboard answers only to names it was given, and binds to `127.0.0.1`, so nothing reaches it except through the tunnel.

## Run it from a checkout instead

To load the logger from a working copy (for example while changing it), skip the plugin install and run:

```
dashboard/install.sh --enable-logging
```

This adds the checkout to `CLAUDE_CODE_PLUGIN_DIRS` in your Claude Code user settings, backing the file up first. Use one way or the other, not both: a plugin installed twice logs every request twice.

## Develop

```
cd dashboard && bun install && bun test     # dashboard: SQLite index, server, page helpers
claude plugin test .                        # the logger's hooks
claude plugin validate .
```

## License

MIT. See [LICENSE](LICENSE).
