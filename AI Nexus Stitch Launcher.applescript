use scripting additions

property projectPath : "/Users/macjanice/Documents/New project"

on run
  display notification "Starting Stitch Edition…" with title "AI Nexus Stitch"
  do shell script "/usr/bin/open -a Docker"

  set dockerBinary to ""
  if my commandExists("/usr/local/bin/docker") then
    set dockerBinary to "/usr/local/bin/docker"
  else if my commandExists("/opt/homebrew/bin/docker") then
    set dockerBinary to "/opt/homebrew/bin/docker"
  end if

  if dockerBinary is "" then
    display alert "Docker command not found" message "Open Docker Desktop, then start Stitch Edition from the project folder with docker compose up -d web-stitch."
    return
  end if

  set dockerReady to false
  repeat 60 times
    try
      do shell script quoted form of dockerBinary & " info >/dev/null 2>&1"
      set dockerReady to true
      exit repeat
    end try
    delay 2
  end repeat

  if not dockerReady then
    display alert "Docker is still starting" message "Please wait for Docker Desktop to finish starting, then open AI Nexus Stitch again."
    return
  end if

  do shell script "cd " & quoted form of projectPath & " && " & quoted form of dockerBinary & " compose up --build -d"
  repeat 30 times
    try
      do shell script "/usr/bin/curl --fail --silent http://localhost:3002/health >/dev/null"
      do shell script "/usr/bin/open http://localhost:3002/dashboard"
      display notification "Stitch Edition is ready." with title "AI Nexus Stitch"
      return
    end try
    delay 2
  end repeat

  display alert "Stitch Edition is still starting" message "Docker has started. Open http://localhost:3002/dashboard in a moment."
end run

on commandExists(commandPath)
  try
    do shell script "/usr/bin/test -x " & quoted form of commandPath
    return true
  on error
    return false
  end try
end commandExists
