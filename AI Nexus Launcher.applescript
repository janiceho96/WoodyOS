on run
  display notification "Starting your local dashboard…" with title "AI Nexus"
  do shell script "/usr/bin/open -a Docker"

  set dockerReady to false
  repeat 60 times
    try
      do shell script "/usr/local/bin/docker info >/dev/null 2>&1"
      set dockerReady to true
      exit repeat
    end try
    delay 2
  end repeat

  if not dockerReady then
    display alert "Docker is still starting" message "Please wait for Docker Desktop to finish starting, then open AI Nexus again."
    return
  end if

  do shell script "cd '/Users/macjanice/Documents/New project' && /usr/local/bin/docker compose up --build -d"
  repeat 30 times
    try
      do shell script "/usr/bin/curl --fail --silent http://localhost:3000/health >/dev/null"
      do shell script "/usr/bin/open http://localhost:3000"
      display notification "AI Nexus is ready." with title "AI Nexus"
      return
    end try
    delay 2
  end repeat

  display alert "AI Nexus is still starting" message "Docker has started. Open http://localhost:3000 in a moment."
end run
