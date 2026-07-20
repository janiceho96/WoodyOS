#include <limits.h>
#include <mach-o/dyld.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

static int launch_with_open(const char *command_path) {
  pid_t child = fork();
  if (child == 0) {
    execl("/usr/bin/open", "open", command_path, (char *)NULL);
    _exit(127);
  }
  if (child < 0) return 1;
  int status = 0;
  if (waitpid(child, &status, 0) < 0) return 1;
  return WIFEXITED(status) ? WEXITSTATUS(status) : 1;
}

int main(void) {
  char executable[PATH_MAX];
  uint32_t executable_size = sizeof(executable);
  if (_NSGetExecutablePath(executable, &executable_size) != 0) return 2;

  char resolved[PATH_MAX];
  if (realpath(executable, resolved) == NULL) {
    if (strlen(executable) >= sizeof(resolved)) return 2;
    strcpy(resolved, executable);
  }
  char *filename = strrchr(resolved, '/');
  if (filename == NULL) return 2;
  *filename = '\0';

  char start_command[PATH_MAX];
  int length = snprintf(start_command, sizeof(start_command), "%s/../Resources/Start Woody.command", resolved);
  if (length < 0 || (size_t)length >= sizeof(start_command) || access(start_command, X_OK) != 0) return 3;

  if (launch_with_open(start_command) == 0) return 0;

  /* Fallback for Macs whose .command file association is unavailable. */
  execl("/bin/zsh", "zsh", start_command, (char *)NULL);
  return 4;
}
