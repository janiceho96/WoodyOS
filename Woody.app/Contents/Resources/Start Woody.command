#!/bin/zsh

launcher_log="/private/tmp/woody-launcher.log"
exec > >(/usr/bin/tee -a "$launcher_log") 2>&1

fail() {
  echo
  echo "Woody could not start: $1"
  echo "Log: $launcher_log"
  echo
  read "?Press Return to close this window. "
  exit 1
}

valid_project() {
  [[ -n "$1" && -f "$1/docker-compose.yml" && -f "$1/web-stitch/package.json" ]]
}

resolve_project() {
  local resource_dir="${0:A:h}"
  local configured=""
  local relative=""
  local candidate=""
  local discovered=""

  if [[ -f "$resource_dir/ProjectRoot" ]]; then
    IFS= read -r configured < "$resource_dir/ProjectRoot"
    if valid_project "$configured"; then
      echo "$configured"
      return 0
    fi
  fi

  relative="$(cd "$resource_dir/../../.." 2>/dev/null && pwd -P)"
  if valid_project "$relative"; then
    echo "$relative"
    return 0
  fi

  while IFS= read -r compose_file; do
    candidate="${compose_file:h}"
    if valid_project "$candidate"; then
      if [[ -n "$discovered" && "$discovered" != "$candidate" ]]; then
        return 2
      fi
      discovered="$candidate"
    fi
  done < <(/usr/bin/find "$HOME/Documents" -maxdepth 4 -type f -name docker-compose.yml 2>/dev/null)

  [[ -n "$discovered" ]] || return 1
  echo "$discovered"
}

project_dir="$(resolve_project)"
resolve_status=$?
[[ $resolve_status -ne 2 ]] || fail "More than one Woody project was found. Reinstall the shortcut from the project you want to use."
[[ $resolve_status -eq 0 ]] || fail "The Woody project folder could not be located. Keep it inside Documents or reinstall the shortcut."
cd "$project_dir" || fail "The Woody project folder could not be opened."
echo "Project: $project_dir"

if [[ "${WOODY_RESOLVE_ONLY:-0}" == "1" ]]; then
  exit 0
fi

echo "[$(/bin/date -Iseconds)] Starting Woody"
/usr/bin/open -a Docker

docker_binary=""
if [[ -x /usr/local/bin/docker ]]; then
  docker_binary="/usr/local/bin/docker"
elif [[ -x /opt/homebrew/bin/docker ]]; then
  docker_binary="/opt/homebrew/bin/docker"
fi

[[ -n "$docker_binary" ]] || fail "Docker command was not found. Install or open Docker Desktop first."

echo "Waiting for Docker Desktop…"
docker_ready=false
for attempt in {1..60}; do
  if "$docker_binary" info >/dev/null 2>&1; then
    docker_ready=true
    break
  fi
  /bin/sleep 2
done

[[ "$docker_ready" == true ]] || fail "Docker Desktop did not become ready within two minutes."

echo "Building and starting Woody…"
"$docker_binary" compose up --build -d || fail "Docker Compose could not build or start the services."

echo "Waiting for the Woody dashboard…"
for attempt in {1..60}; do
  if /usr/bin/curl --fail --silent http://localhost:3002/health >/dev/null; then
    echo "Woody is ready. Opening the dashboard…"
    /usr/bin/open 'http://localhost:3002/dashboard?brand=woody-v2'
    /usr/bin/osascript -e 'display notification "Woody is ready." with title "Woody"' >/dev/null 2>&1 || true
    /bin/sleep 2
    exit 0
  fi
  /bin/sleep 2
done

fail "The services started, but port 3002 did not become healthy."
