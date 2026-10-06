# macOS login startup

Fieldnotes runs as a per-user `launchd` agent on this Mac. The generated property list lives at `~/Library/LaunchAgents/com.byungsker.fieldnotes.plist`; the installer creates it from this checkout and does not add it to Git. It starts the existing production build at login and relaunches it if the process exits. It runs as the logged-in user, binds through the app's existing loopback default, and loads the existing `.env` from the project directory. It does not start before login or change Tailscale Serve, firewall, or account settings.

## Install

Build the production app, stop any existing Fieldnotes server gracefully, then run:

```sh
npm run build
./scripts/install-launch-agent.sh
```

The installer refuses to overwrite an existing job or plist and refuses to start while port 4177 is occupied. It resolves the current shell's absolute Node.js path, writes a mode-600 plist, and creates mode-600 stdout/stderr logs under `~/Library/Logs/Fieldnotes/`. The launchd process uses the repository as its working directory, so relative data paths and `.env` resolution match `npm start`.

## Check status and logs

```sh
launchctl print "gui/$(id -u)/com.byungsker.fieldnotes"
lsof -nP -iTCP:4177 -sTCP:LISTEN
tail -n 100 "$HOME/Library/Logs/Fieldnotes/stdout.log"
tail -n 100 "$HOME/Library/Logs/Fieldnotes/stderr.log"
```

For the private HTTPS route, check the existing Tailscale Serve URL from an authorized tailnet device. The application itself continues to bind to `127.0.0.1:4177`.

## Stop and disable login startup

```sh
launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.byungsker.fieldnotes.plist"
launchctl disable "gui/$(id -u)/com.byungsker.fieldnotes"
```

This stops the current job and prevents loading it at the next login. The plist, logs, app, and data remain in place. To re-enable the existing job:

```sh
launchctl enable "gui/$(id -u)/com.byungsker.fieldnotes"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.byungsker.fieldnotes.plist"
```

The installer does not replace a previously generated plist. If the checkout moves, inspect the plist's `WorkingDirectory` and Node.js `ProgramArguments`, update them to the new absolute paths, then bootstrap the job again.
